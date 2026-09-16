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

// Sharp for sticker conversion
let sharp;
try {
    sharp = require('sharp');
} catch (e) {
    console.log('⚠️ sharp not installed. Sticker will use raw buffer.');
}

// ffmpeg for audio conversion
let ffmpeg;
try {
    ffmpeg = require('fluent-ffmpeg');
} catch (e) {
    console.log('⚠️ fluent-ffmpeg not installed. Using system ffmpeg.');
}

const Session = require('./Id');
const { get, input, ensureConfig, handleSettingUpdate } = require('./configdb');

const SESSION_BASE_PATH = path.join(__dirname, './sessions');
const BOT_IMAGE_URL = 'https://github.com/nimsara-web/Im-Nim/raw/refs/heads/main/Data/Nim-Bot-New-Logo.jfif';
const BOT_AUDIO_URL = 'https://github.com/nimsara-web/Im-Nim/raw/refs/heads/main/Data/welcome%20nim%20new.MP3';
const BOT_CHANNEL_LINK = 'https://whatsapp.com/channel/0029Vb0bsRuFnSz4XAQ2yT0r';
const CHANNEL_JID = '120363362308230584@newsletter';
const DEFAULT_OWNER_NUMBER = '94784280074';

// 🔑 NIM API Key
const NIM_API_KEY = 'zan_natXAWcy_8hpi5yn4b6';
const NIM_API_BASE = 'https://api.zanta-mini.store';

// ==========================================
// 🔑 OWNER SYSTEM - MAIN OWNERS (PROTECTED)
// ==========================================
const MAIN_OWNER_NUMBERS = ['94784280074', '94701726411'];

// 🔑 Original bot name & logo for reset
const ORIGINAL_BOT_NAME = 'NIM BOT';
const ORIGINAL_BOT_LOGO = BOT_IMAGE_URL;

// 🔑 GLOBAL Owner list (shared across ALL sessions)
let GLOBAL_OWNER_LIST = [...MAIN_OWNER_NUMBERS];
let GLOBAL_OWNER_LIST_LOADED = false;

const FOOTER = '\n\n> © ᴄʀᴇᴀᴛᴏʀ ʙY ɴɪᴍꜱᴀʀᴀ 🥷🏻';

const socketCreationTime = new Map();
const activeSockets = new Map();
const messageCache = new Map();
const deletedMessages = new Map();
const reconnectAttempts = new Map();
const userCategoryState = new Map();
const menuMessageIds = new Map();
const groupAntiLink = new Map();
const groupWelcome = new Map();

// 🔑 Per-session nodelete state (botNumber -> Map of chatId -> status)
const chatNodelete = new Map();

// 🔑 Quality selection pending state
const pendingQualitySelection = new Map();

// 🔑 AutoSave settings
const autoSaveSettings = new Map();

// 🔑 Per-session AutoReply settings
const autoReplySettings = new Map();

// 🔑 Per-session Custom Replies
const customReplies = new Map();

// 🔑 Movie selection pending
const movieSelection = new Map();

// 🔑 VVP Recipient Settings (per-session) - stores 1 or 2 emojis
const vvpEmojis = new Map();

// 🔑 Status Reaction Settings (per-session) - stores emoji for status forward
const statusReactionEmojis = new Map();

// 🔑 Anti-spam settings (per-session -> Map of chatId -> status)
const antiSpamSettings = new Map();

// ==========================================
// 🛡️ GETCONTACT GLOBAL LOCK (Prevent Ban)
// ==========================================
const getContactLocks = new Map();

// ==========================================
// 🛡️ AUTO-REPLY ANTI-LOOP SYSTEM
// ==========================================
const autoReplyTracker = new Map();
const AUTO_REPLY_WINDOW = 60000;
const AUTO_REPLY_MAX_COUNT = 3;

// ==========================================
// 🔑 STRICT Owner Check - GLOBAL
// ==========================================
function isOwnerNumber(number) {
    if (!number) return false;
    const clean = number.replace(/[^0-9]/g, '');
    return GLOBAL_OWNER_LIST.includes(clean);
}

function isMainOwnerNumber(number) {
    if (!number) return false;
    const clean = number.replace(/[^0-9]/g, '');
    return MAIN_OWNER_NUMBERS.includes(clean);
}

// ==========================================
// 🛡️ Bot Message Detection (prevent auto-reply to bots)
// ==========================================
function isBotMessage(msg) {
    if (!msg) return false;
    
    // Check if message is from a bot (has bot indicators)
    const text = (msg.message?.conversation || 
                  msg.message?.extendedTextMessage?.text || 
                  msg.message?.imageMessage?.caption || 
                  msg.message?.videoMessage?.caption || '').toLowerCase();
    
    // Bot response patterns
    const botPatterns = [
        '© ᴄʀᴇᴀᴛᴏʀ ʙY',
        '© creator by',
        '> © ᴄʀᴇᴀᴛᴏʀ',
        '*╭─`',
        '*╰──────',
        'ᴍᴀɪɴ ᴍᴇɴᴜ',
        'menu categories',
        'reply to this message with a number',
        'download commands',
        'settings commands',
        'owner commands',
        'utility commands',
        'group admin',
        'fun commands',
        'ai assistant',
        '🤖 *ai',
        '🏓 *pong',
        '💾 *autosave',
        '✅ *anti',
        '❌ *', '⚠️ *', '✅ *', '⚙️ *', '📥 *', '🎬 *',
        'deleted message detected',
        'view once received',
        'your status saved',
        'spam detected',
        'link detected',
        'pair code generated',
        'bot connected',
        'nim bot',
        'zanta-mini.store',
        'nimsara-official',
        'whatsapp.com/channel/0029Vb0bsRuFnSz4XAQ2yT0r'
    ];
    
    // Check text patterns
    for (const pattern of botPatterns) {
        if (text.includes(pattern.toLowerCase())) return true;
    }
    
    // Check if message has forwarded newsletter context (bot indicator)
    const contextInfo = msg.message?.extendedTextMessage?.contextInfo || 
                        msg.message?.imageMessage?.contextInfo || 
                        msg.message?.videoMessage?.contextInfo;
    
    if (contextInfo?.forwardedNewsletterMessageInfo) {
        const jid = contextInfo.forwardedNewsletterMessageInfo.newsletterJid || '';
        if (jid && jid.includes('newsletter')) return true;
    }
    
    return false;
}

// ==========================================
// 🔑 Per-Session Nodelete Helpers
// ==========================================
function getNodeleteState(botNumber) {
    if (!chatNodelete.has(botNumber)) {
        chatNodelete.set(botNumber, new Map());
    }
    return chatNodelete.get(botNumber);
}

async function getNodeleteStatus(botNumber, chatJid) {
    const state = getNodeleteState(botNumber);
    let status = state.get(chatJid);
    
    if (status === undefined || status === null) {
        let dbVal = null;
        try { dbVal = await get(`NODELETE_${chatJid}`, botNumber); } catch (e) {}
        if (!dbVal) {
            try { 
                const cleanKey = chatJid.replace(/[^0-9]/g, '');
                dbVal = await get(`NODELETE_${cleanKey}`, botNumber); 
            } catch (e) {}
        }
        status = dbVal || 'off';
        state.set(chatJid, status);
    }
    return status;
}

async function setNodeleteStatus(botNumber, chatJid, status) {
    const state = getNodeleteState(botNumber);
    state.set(chatJid, status);
    
    try {
        await handleSettingUpdate(`NODELETE_${chatJid}`, status, () => {}, botNumber);
    } catch (e) {
        try {
            const cleanKey = chatJid.replace(/[^0-9]/g, '');
            await handleSettingUpdate(`NODELETE_${cleanKey}`, status, () => {}, botNumber);
        } catch (e2) {}
    }
}

// ==========================================
// 🔑 Per-Session AutoReply Helpers
// ==========================================
function getAutoReplyState(botNumber) {
    if (!autoReplySettings.has(botNumber)) {
        autoReplySettings.set(botNumber, { mode: 'off', customReplies: {} });
    }
    return autoReplySettings.get(botNumber);
}

async function loadAutoReplySettings(botNumber) {
    try {
        const savedMode = await get('AUTOREPLY_MODE', botNumber);
        const savedReplies = await get('AUTOREPLY_LIST', botNumber);
        
        const state = getAutoReplyState(botNumber);
        state.mode = savedMode || 'off';
        
        if (savedReplies) {
            try {
                state.customReplies = JSON.parse(savedReplies);
            } catch (e) {
                state.customReplies = {};
            }
        }
    } catch (e) {}
}

async function saveAutoReplySettings(botNumber) {
    const state = getAutoReplyState(botNumber);
    try {
        await handleSettingUpdate('AUTOREPLY_MODE', state.mode, () => {}, botNumber);
        await handleSettingUpdate('AUTOREPLY_LIST', JSON.stringify(state.customReplies), () => {}, botNumber);
    } catch (e) {}
}

// ==========================================
// 🔑 Anti-Spam Helpers
// ==========================================
function getAntiSpamState(botNumber) {
    if (!antiSpamSettings.has(botNumber)) {
        antiSpamSettings.set(botNumber, new Map());
    }
    return antiSpamSettings.get(botNumber);
}

async function getAntiSpamStatus(botNumber, chatJid) {
    const state = getAntiSpamState(botNumber);
    let status = state.get(chatJid);
    
    if (status === undefined || status === null) {
        let dbVal = null;
        try { dbVal = await get(`ANTISPAM_${chatJid}`, botNumber); } catch (e) {}
        if (!dbVal) {
            try { 
                const cleanKey = chatJid.replace(/[^0-9]/g, '');
                dbVal = await get(`ANTISPAM_${cleanKey}`, botNumber); 
            } catch (e) {}
        }
        status = dbVal || 'off';
        state.set(chatJid, status);
    }
    return status;
}

async function setAntiSpamStatus(botNumber, chatJid, status) {
    const state = getAntiSpamState(botNumber);
    state.set(chatJid, status);
    
    try {
        await handleSettingUpdate(`ANTISPAM_${chatJid}`, status, () => {}, botNumber);
    } catch (e) {
        try {
            const cleanKey = chatJid.replace(/[^0-9]/g, '');
            await handleSettingUpdate(`ANTISPAM_${cleanKey}`, status, () => {}, botNumber);
        } catch (e2) {}
    }
}

// ==========================================
// 🔑 VVP Silent Helpers (2 emojis trigger)
// ==========================================
function getVvpEmojis(botNumber) {
    if (!vvpEmojis.has(botNumber)) {
        vvpEmojis.set(botNumber, '❤️,🔥');
    }
    return vvpEmojis.get(botNumber);
}

async function loadVvpSettings(botNumber) {
    try {
        const emojis = await get('VVP_EMOJIS', botNumber);
        if (emojis) {
            vvpEmojis.set(botNumber, emojis);
        }
    } catch (e) {}
}

async function saveVvpSettings(botNumber) {
    try {
        await handleSettingUpdate('VVP_EMOJIS', getVvpEmojis(botNumber), () => {}, botNumber);
    } catch (e) {}
}

// ==========================================
// 🔑 Status Reaction Helpers (.statusr)
// ==========================================
function getStatusReactionEmoji(botNumber) {
    if (!statusReactionEmojis.has(botNumber)) {
        statusReactionEmojis.set(botNumber, '');
    }
    return statusReactionEmojis.get(botNumber);
}

async function loadStatusReactionSettings(botNumber) {
    try {
        const emoji = await get('STATUS_REACTION_EMOJI', botNumber);
        if (emoji) {
            statusReactionEmojis.set(botNumber, emoji);
        }
    } catch (e) {}
}

async function saveStatusReactionSettings(botNumber) {
    try {
        await handleSettingUpdate('STATUS_REACTION_EMOJI', getStatusReactionEmoji(botNumber), () => {}, botNumber);
    } catch (e) {}
}

// ==========================================
// 🔑 GLOBAL Owner List Loader
// ==========================================
async function loadGlobalOwnerList() {
    try {
        const allSessions = await Session.find({});
        for (const session of allSessions) {
            try {
                const savedList = await get('OWNER_LIST', session.number);
                if (savedList) {
                    const parsed = JSON.parse(savedList);
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        const merged = [...new Set([...MAIN_OWNER_NUMBERS, ...parsed])];
                        GLOBAL_OWNER_LIST = merged;
                        GLOBAL_OWNER_LIST_LOADED = true;
                        console.log(`✅ Global owner list loaded: ${GLOBAL_OWNER_LIST.join(', ')}`);
                        return;
                    }
                }
            } catch (e) {}
        }
        GLOBAL_OWNER_LIST = [...MAIN_OWNER_NUMBERS];
        GLOBAL_OWNER_LIST_LOADED = true;
    } catch (e) {
        GLOBAL_OWNER_LIST = [...MAIN_OWNER_NUMBERS];
        GLOBAL_OWNER_LIST_LOADED = true;
    }
}

async function saveGlobalOwnerList() {
    try {
        const allSessions = await Session.find({});
        for (const session of allSessions) {
            try {
                await handleSettingUpdate('OWNER_LIST', JSON.stringify(GLOBAL_OWNER_LIST), () => {}, session.number);
            } catch (e) {}
        }
        console.log(`✅ Owner list saved to ${allSessions.length} sessions`);
    } catch (e) {
        console.log('⚠️ Failed to save global owner list:', e.message);
    }
}

// ==========================================
// 🛡️ Auto-Reply Loop Detection
// ==========================================
function canAutoReply(botNumber, senderJid) {
    const now = Date.now();
    const key = `${botNumber}_${senderJid}`;
    
    let tracker = autoReplyTracker.get(key);
    
    if (!tracker || (now - tracker.firstTime) > AUTO_REPLY_WINDOW) {
        tracker = { count: 1, firstTime: now };
        autoReplyTracker.set(key, tracker);
        return true;
    }
    
    tracker.count++;
    
    if (tracker.count > AUTO_REPLY_MAX_COUNT) {
        console.log(`[AUTO-REPLY] 🛑 Loop detected! Blocked reply to ${senderJid} (count: ${tracker.count})`);
        return false;
    }
    
    return true;
}

setInterval(() => {
    const now = Date.now();
    for (const [key, tracker] of autoReplyTracker) {
        if (now - tracker.firstTime > AUTO_REPLY_WINDOW * 2) {
            autoReplyTracker.delete(key);
        }
    }
}, 120000);

// ==========================================
// 🔑 Get Owner Number from DB
// ==========================================
async function getOwnerNumber(botNumber) {
    try {
        const ownerNum = await get(`OWNER_NUMBER`, botNumber);
        if (ownerNum) return ownerNum.replace(/[^0-9]/g, '');
    } catch (e) {}
    return DEFAULT_OWNER_NUMBER;
}

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

// ==========================================
// 🔧 Extract quoted/actual message properly
// ==========================================
function unwrapMessage(message) {
    if (!message) return null;
    
    while (
        message.ephemeralMessage ||
        message.viewOnceMessage ||
        message.viewOnceMessageV2 ||
        message.viewOnceMessageV2Extension ||
        message.documentWithCaptionMessage
    ) {
        if (message.ephemeralMessage) message = message.ephemeralMessage.message;
        else if (message.viewOnceMessage) message = message.viewOnceMessage.message;
        else if (message.viewOnceMessageV2) message = message.viewOnceMessageV2.message;
        else if (message.viewOnceMessageV2Extension) message = message.viewOnceMessageV2Extension.message;
        else if (message.documentWithCaptionMessage) message = message.documentWithCaptionMessage.message;
    }
    
    return message;
}

// ==========================================
// 🔧 Get media type from message
// ==========================================
function getMediaType(message) {
    if (!message) return null;
    const unwrapped = unwrapMessage(message);
    if (!unwrapped) return null;
    
    const types = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'];
    for (const type of types) {
        if (unwrapped[type]) return { type, data: unwrapped[type] };
    }
    return null;
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
// 🔑 Channel Forward Context Info
// ==========================================
function getChannelContext() {
    return {
        forwardingScore: 999,
        isForwarded: true,
        forwardedNewsletterMessageInfo: {
            newsletterJid: CHANNEL_JID,
            newsletterName: 'NIM PROJECT',
            serverMessageId: 100
        }
    };
}

// ==========================================
// 🔑 Bot Detection Bypass Helpers
// ==========================================
async function humanDelay(minMs = 1500, maxMs = 3500) {
    const randomDelay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    await delay(randomDelay);
}

async function sendWithTyping(sock, jid, message, options = {}) {
    try {
        await sock.sendPresenceUpdate('composing', jid);
        await humanDelay(800, 1800);
        await sock.sendPresenceUpdate('paused', jid);
        await delay(300);
    } catch (e) {}
    
    return await sock.sendMessage(jid, message, options);
}

// ==========================================
// 🔧 Sticker Conversion
// ==========================================
async function convertToSticker(buffer, isVideo = false) {
    try {
        if (!sharp) {
            console.log('⚠️ Sharp not available, returning raw buffer');
            return buffer;
        }

        const meta = await sharp(buffer, { animated: !!isVideo }).metadata();
        console.log(`[STICKER] Input: ${meta.width}x${meta.height}, format: ${meta.format}, animated: ${!!isVideo}`);

        if (isVideo) {
            try {
                const result = await sharp(buffer, {
                    animated: true,
                    limitInputPixels: false,
                    pages: -1
                })
                    .resize(512, 512, {
                        fit: 'contain',
                        background: { r: 0, g: 0, b: 0, alpha: 0 }
                    })
                    .webp({
                        quality: 55,
                        effort: 4,
                        loop: 0,
                        delay: 100,
                        lossless: false,
                        nearLossless: false
                    })
                    .toBuffer();
                
                if (result && result.length > 100 && 
                    result[0] === 0x52 && result[1] === 0x49 && 
                    result[2] === 0x46 && result[3] === 0x46) {
                    console.log(`[STICKER] ✅ Animated WebP: ${result.length} bytes`);
                    return result;
                }
            } catch (animErr) {
                console.log('[STICKER] Animated failed, trying first frame:', animErr.message);
            }

            try {
                const result = await sharp(buffer, { 
                    animated: false, 
                    page: 0,
                    limitInputPixels: false 
                })
                    .resize(512, 512, {
                        fit: 'contain',
                        background: { r: 0, g: 0, b: 0, alpha: 0 }
                    })
                    .ensureAlpha()
                    .webp({
                        quality: 75,
                        effort: 4,
                        lossless: false
                    })
                    .toBuffer();
                
                console.log(`[STICKER] ✅ Static fallback: ${result.length} bytes`);
                return result;
            } catch (staticErr) {
                console.log('[STICKER] Static fallback failed:', staticErr.message);
                return buffer;
            }
        } else {
            const result = await sharp(buffer, {
                limitInputPixels: false,
                failOnError: false
            })
                .rotate()
                .resize(512, 512, {
                    fit: 'contain',
                    background: { r: 0, g: 0, b: 0, alpha: 0 },
                    withoutEnlargement: false
                })
                .ensureAlpha()
                .webp({
                    quality: 80,
                    effort: 4,
                    lossless: false,
                    smartSubsample: true
                })
                .toBuffer();
            
            if (result && result.length > 100 && 
                result[0] === 0x52 && result[1] === 0x49 && 
                result[2] === 0x46 && result[3] === 0x46) {
                console.log(`[STICKER] ✅ Static WebP: ${result.length} bytes`);
                return result;
            } else {
                console.log('[STICKER] ⚠️ Invalid WebP header, returning raw');
                return buffer;
            }
        }
    } catch (e) {
        console.error('[STICKER] Conversion error:', e.message);
        return buffer;
    }
}

// ==========================================
// 🔧 TTS Audio Conversion
// ==========================================
async function convertTtsToOpus(mp3Buffer) {
    try {
        const tmpDir = path.join(__dirname, 'tmp');
        await fs.ensureDir(tmpDir);
        
        const tmpMp3 = path.join(tmpDir, `tts_${Date.now()}.mp3`);
        const tmpOgg = path.join(tmpDir, `tts_${Date.now()}.ogg`);
        
        await fs.writeFile(tmpMp3, mp3Buffer);

        await new Promise((resolve, reject) => {
            exec(
                `ffmpeg -i "${tmpMp3}" -c:a libopus -b:a 48k -ar 48000 -ac 1 -vbr on -compression_level 10 -frame_duration 60 -application voip "${tmpOgg}" -y`,
                { timeout: 30000 },
                (error, stdout, stderr) => {
                    if (error) {
                        console.error('ffmpeg error:', stderr || error.message);
                        reject(error);
                    } else {
                        resolve();
                    }
                }
            );
        });

        const oggBuffer = await fs.readFile(tmpOgg);

        await fs.remove(tmpMp3).catch(() => {});
        await fs.remove(tmpOgg).catch(() => {});

        return oggBuffer;
    } catch (e) {
        console.error('TTS conversion error:', e.message);
        return null;
    }
}

// ==========================================
// 🔧 Download Helpers
// ==========================================
async function downloadUrlToBuffer(url, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: 60000,
                maxRedirects: 5,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': '*/*',
                    'Accept-Language': 'en-US,en;q=0.9'
                }
            });
            
            if (response.data && response.data.length > 1000) {
                return Buffer.from(response.data);
            }
        } catch (e) {
            console.log(`[DOWNLOAD] Attempt ${attempt}/${maxRetries} failed: ${e.message}`);
            if (attempt < maxRetries) await delay(2000);
        }
    }
    return null;
}

async function downloadYoutubeAudio(youtubeUrl) {
    try {
        const apiUrl = `${NIM_API_BASE}/api/ytmp3?apiKey=${NIM_API_KEY}&url=${encodeURIComponent(youtubeUrl)}`;
        const response = await axios.get(apiUrl, { timeout: 45000 });
        const audioUrl = response.data?.result?.url 
                      || response.data?.result?.download_url
                      || response.data?.data?.url 
                      || response.data?.url 
                      || response.data?.result?.audio;
        if (audioUrl && audioUrl.startsWith('http')) {
            console.log('[YT AUDIO] ✅ NIM API succeeded');
            const buffer = await downloadUrlToBuffer(audioUrl);
            if (buffer) return buffer;
            return { url: audioUrl };
        }
    } catch (e) {
        console.log('[YT AUDIO] NIM API failed:', e.message);
    }

    try {
        const { stdout } = await execPromise(`yt-dlp --get-url -f bestaudio "${youtubeUrl}"`, { timeout: 30000 });
        const url = stdout.trim().split('\n')[0];
        if (url && url.startsWith('http')) {
            const buffer = await downloadUrlToBuffer(url);
            if (buffer) return buffer;
            return { url };
        }
    } catch (e) {}

    return null;
}

async function downloadYoutubeVideo(youtubeUrl) {
    try {
        const apiUrl = `${NIM_API_BASE}/api/ytmp4-v2?apiKey=${NIM_API_KEY}&url=${encodeURIComponent(youtubeUrl)}`;
        const response = await axios.get(apiUrl, { timeout: 45000 });
        const videoUrl = response.data?.result?.url 
                      || response.data?.data?.url 
                      || response.data?.url 
                      || response.data?.result?.download_url
                      || response.data?.downloadUrl;
        if (videoUrl && videoUrl.startsWith('http')) {
            console.log('[YT VIDEO] ✅ NIM API succeeded');
            const buffer = await downloadUrlToBuffer(videoUrl);
            if (buffer) return buffer;
            return { url: videoUrl };
        }
    } catch (e) {
        console.log('[YT VIDEO] NIM API failed:', e.message);
    }

    try {
        const { stdout } = await execPromise(`yt-dlp --get-url -f "best[ext=mp4]/best" "${youtubeUrl}"`, { timeout: 30000 });
        const url = stdout.trim().split('\n')[0];
        if (url && url.startsWith('http')) {
            const buffer = await downloadUrlToBuffer(url);
            if (buffer) return buffer;
            return { url };
        }
    } catch (e) {}

    return null;
}

async function downloadTikTok(tiktokUrl) {
    try {
        const apiUrl = `${NIM_API_BASE}/api/tiktok?apiKey=${NIM_API_KEY}&url=${encodeURIComponent(tiktokUrl)}`;
        const response = await axios.get(apiUrl, { timeout: 45000 });
        const videoUrl = response.data?.result?.video 
                      || response.data?.result?.url
                      || response.data?.data?.video 
                      || response.data?.data?.url 
                      || response.data?.video 
                      || response.data?.url 
                      || response.data?.result?.download_url
                      || response.data?.downloadUrl
                      || response.data?.result?.play;
        if (videoUrl && videoUrl.startsWith('http')) {
            console.log('[TIKTOK] ✅ NIM API succeeded');
            const buffer = await downloadUrlToBuffer(videoUrl);
            if (buffer) return buffer;
            return { url: videoUrl };
        }
    } catch (e) {
        console.log('[TIKTOK] NIM API failed:', e.message);
    }

    try {
        const apiRes = await axios.get(`https://api.siputzx.my.id/api/d/tiktok?url=${encodeURIComponent(tiktokUrl)}`, { timeout: 30000 });
        const url = apiRes.data?.data?.video || apiRes.data?.video || apiRes.data?.url;
        if (url) {
            console.log('[TIKTOK] ✅ siputzx API succeeded');
            const buffer = await downloadUrlToBuffer(url);
            if (buffer) return buffer;
            return { url };
        }
    } catch (e) {
        console.log('[TIKTOK] siputzx API failed');
    }

    return null;
}

async function downloadFacebook(fbUrl) {
    try {
        const apiUrl = `${NIM_API_BASE}/api/facebook?apiKey=${NIM_API_KEY}&url=${encodeURIComponent(fbUrl)}`;
        const response = await axios.get(apiUrl, { timeout: 45000 });
        const videoUrl = response.data?.result?.hd 
                      || response.data?.result?.sd
                      || response.data?.result?.url 
                      || response.data?.data?.url 
                      || response.data?.url 
                      || response.data?.hd
                      || response.data?.sd;
        if (videoUrl && videoUrl.startsWith('http')) {
            console.log('[FB] ✅ NIM API succeeded');
            const buffer = await downloadUrlToBuffer(videoUrl);
            if (buffer) return buffer;
            return { url: videoUrl };
        }
    } catch (e) {
        console.log('[FB] NIM API failed:', e.message);
    }

    try {
        const apiRes = await axios.get(`https://api.siputzx.my.id/api/d/facebook?url=${encodeURIComponent(fbUrl)}`, { timeout: 30000 });
        const url = apiRes.data?.data?.hd || apiRes.data?.data?.sd || apiRes.data?.url;
        if (url) {
            const buffer = await downloadUrlToBuffer(url);
            if (buffer) return buffer;
            return { url };
        }
    } catch (e) {}

    return null;
}

async function downloadInstagram(igUrl) {
    try {
        const apiUrl = `${NIM_API_BASE}/api/instagram?apiKey=${NIM_API_KEY}&url=${encodeURIComponent(igUrl)}`;
        const response = await axios.get(apiUrl, { timeout: 45000 });
        const mediaData = response.data?.result 
                       || response.data?.data 
                       || response.data?.medias;
        if (mediaData && Array.isArray(mediaData) && mediaData.length > 0) {
            console.log('[IG] ✅ NIM API succeeded');
            return mediaData;
        }
    } catch (e) {
        console.log('[IG] NIM API failed:', e.message);
    }

    try {
        const apiRes = await axios.get(`https://api.siputzx.my.id/api/d/igdl?url=${encodeURIComponent(igUrl)}`, { timeout: 30000 });
        const mediaData = apiRes.data?.data;
        if (mediaData && mediaData.length > 0) {
            return mediaData;
        }
    } catch (e) {}

    return null;
}

async function searchMovie(query) {
    try {
        const apiUrl = `${NIM_API_BASE}/api/movie/search?apiKey=${NIM_API_KEY}&q=${encodeURIComponent(query)}`;
        const response = await axios.get(apiUrl, { timeout: 30000 });
        return response.data?.result || response.data?.data || response.data?.results;
    } catch (e) {
        console.log('[MOVIE] Search failed:', e.message);
        return null;
    }
}

async function downloadMovie(movieId) {
    try {
        const apiUrl = `${NIM_API_BASE}/api/movie/download?apiKey=${NIM_API_KEY}&id=${encodeURIComponent(movieId)}`;
        const response = await axios.get(apiUrl, { timeout: 45000 });
        return response.data?.result || response.data?.data || response.data?.downloadUrl;
    } catch (e) {
        console.log('[MOVIE] Download failed:', e.message);
        return null;
    }
}

async function askAI(query) {
    try {
        const apiUrl = `${NIM_API_BASE}/api/ai/gpt?apiKey=${NIM_API_KEY}&q=${encodeURIComponent(query)}`;
        const response = await axios.get(apiUrl, { timeout: 30000 });
        const answer = response.data?.result || response.data?.data || response.data?.response || response.data?.answer;
        if (answer) return answer;
    } catch (e) {
        console.log('[AI] NIM API failed:', e.message);
    }

    const apis = [
        { url: `https://bk9.fun/ai/gemini?q=${encodeURIComponent(query)}`, extract: (d) => d?.result || d?.gpt || d?.answer },
        { url: `https://api.siputzx.my.id/api/ai/chatgpt?q=${encodeURIComponent(query)}`, extract: (d) => d?.data || d?.response },
        { url: `https://delirius-apiofc.vercel.app/ai/gpt4?q=${encodeURIComponent(query)}`, extract: (d) => d?.data || d?.response }
    ];

    for (const api of apis) {
        try {
            const res = await axios.get(api.url, { timeout: 15000 });
            const answer = api.extract(res.data);
            if (answer) return answer;
        } catch (e) {}
    }
    return null;
}

async function generateAIImage(prompt) {
    try {
        const apiUrl = `${NIM_API_BASE}/api/ai/imagine?apiKey=${NIM_API_KEY}&prompt=${encodeURIComponent(prompt)}`;
        const response = await axios.get(apiUrl, { timeout: 45000 });
        const imageUrl = response.data?.result?.url || response.data?.data?.url || response.data?.url || response.data?.result;
        if (imageUrl && imageUrl.startsWith('http')) return imageUrl;
    } catch (e) {}

    const apis = [
        { url: `https://api.siputzx.my.id/api/ai/stable-diffusion?prompt=${encodeURIComponent(prompt)}`, extract: (d) => d?.data?.url || d?.result || d?.url },
        { url: `https://api.nekosia.cat/api/v1/images/text2image?prompt=${encodeURIComponent(prompt)}`, extract: (d) => d?.image?.url || d?.url }
    ];

    for (const api of apis) {
        try {
            const res = await axios.get(api.url, { timeout: 30000 });
            const imageUrl = api.extract(res.data);
            if (imageUrl && imageUrl.startsWith('http')) return imageUrl;
        } catch (e) {}
    }
    return null;
}

async function generateFakeChat(name, message) {
    const apis = [
        `https://api.siputzx.my.id/api/m/fakechat?name=${encodeURIComponent(name)}&message=${encodeURIComponent(message)}`,
        `https://api.siputzx.my.id/api/m/fakechat/iphone?name=${encodeURIComponent(name)}&message=${encodeURIComponent(message)}`,
        `https://api.siputzx.my.id/api/m/fakechat/android?name=${encodeURIComponent(name)}&message=${encodeURIComponent(message)}`
    ];

    for (const apiUrl of apis) {
        try {
            const res = await axios.get(apiUrl, { timeout: 20000, responseType: 'arraybuffer' });
            if (res.data && res.data.length > 1000) {
                return Buffer.from(res.data);
            }
        } catch (e) {}
    }
    return null;
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

    // ==========================================
    // 🔑 VVP SILENT + STATUS REACTION via EMOJI REACTION
    // ==========================================
    socket.ev.on('messages.reaction', async (reactions) => {
        try {
            for (const reaction of reactions) {
                const { key, reaction: reactionData } = reaction;
                if (!reactionData?.text) continue;
                
                const emoji = reactionData.text;
                
                // 🔑 Check if this is a STATUS reaction
                if (key.remoteJid === 'status@broadcast') {
                    const statusEmoji = getStatusReactionEmoji(number);
                    
                    if (statusEmoji && emoji === statusEmoji) {
                        // Check if this status is from this bot's own number
                        const statusSender = (key.participant || '').split('@')[0];
                        
                        if (statusSender === number) {
                            console.log(`[STATUS-REACTION] ${emoji} reacted to own status, forwarding silently...`);
                            
                            let targetMsg = messageCache.get(key.id);
                            
                            if (!targetMsg) {
                                // Try to find in cache by stanzaId
                                for (const [cacheKey, value] of messageCache) {
                                    if (value?.key?.id === key.id) {
                                        targetMsg = value;
                                        break;
                                    }
                                }
                            }
                            
                            if (!targetMsg || !targetMsg.message) {
                                console.log(`[STATUS-REACTION] Status message not found in cache`);
                                continue;
                            }
                            
                            try {
                                const msgContent = unwrapMessage(targetMsg.message);
                                const mediaInfo = getMediaType(msgContent);
                                
                                const ownJid = `${number}@s.whatsapp.net`;
                                
                                if (mediaInfo) {
                                    const { type: messageType, data: mediaData } = mediaInfo;
                                    
                                    const buffer = await downloadMediaMessage(
                                        {
                                            key: { 
                                                remoteJid: 'status@broadcast', 
                                                id: key.id, 
                                                participant: key.participant 
                                            },
                                            message: targetMsg.message
                                        },
                                        'buffer',
                                        {},
                                        { logger: pino({ level: 'silent' }) }
                                    );
                                    
                                    const caption = `📸 *Your Status Saved*\n\n🕐 ${new Date().toLocaleString()}`;
                                    
                                    if (messageType === 'imageMessage') {
                                        await socket.sendMessage(ownJid, {
                                            image: buffer,
                                            caption: caption
                                        });
                                    } else if (messageType === 'videoMessage') {
                                        await socket.sendMessage(ownJid, {
                                            video: buffer,
                                            caption: caption
                                        });
                                    } else if (messageType === 'audioMessage') {
                                        await socket.sendMessage(ownJid, {
                                            audio: buffer,
                                            mimetype: mediaData?.mimetype || 'audio/mpeg'
                                        });
                                    }
                                    
                                    console.log(`[STATUS-REACTION] ✅ Status media saved silently`);
                                } else {
                                    // Text status
                                    let statusText = targetMsg.message?.conversation || 
                                                    targetMsg.message?.extendedTextMessage?.text || '';
                                    
                                    if (statusText) {
                                        await socket.sendMessage(ownJid, {
                                            text: `📸 *Your Status Saved*\n\n💬 ${statusText}\n\n🕐 ${new Date().toLocaleString()}`
                                        });
                                        console.log(`[STATUS-REACTION] ✅ Text status saved silently`);
                                    }
                                }
                            } catch (e) {
                                console.log(`[STATUS-REACTION] Error: ${e.message}`);
                            }
                        }
                    }
                    continue;
                }
                
                // 🔑 Check if this is a VVP (ViewOnce) reaction
                const myEmojis = getVvpEmojis(number).split(',').map(e => e.trim()).filter(e => e.length > 0);
                
                if (!myEmojis.includes(emoji)) continue;
                
                // Find the message that was reacted to
                let targetMsg = messageCache.get(key.id);
                if (!targetMsg) continue;
                
                // Check if it's a view-once message
                let msgContent = unwrapMessage(targetMsg.message);
                if (!msgContent) continue;
                
                const mediaInfo = getMediaType(msgContent);
                if (!mediaInfo || !['imageMessage', 'videoMessage'].includes(mediaInfo.type)) continue;
                
                const originalMsg = targetMsg.message;
                const isViewOnce = originalMsg?.viewOnceMessage || 
                                   originalMsg?.viewOnceMessageV2 || 
                                   originalMsg?.viewOnceMessageV2Extension ||
                                   (originalMsg?.imageMessage?.viewOnce) ||
                                   (originalMsg?.videoMessage?.viewOnce);
                
                if (!isViewOnce) continue;
                
                console.log(`[VVP-EMOJI] ${emoji} reacted to view-once, forwarding silently...`);
                
                const { type: messageType, data: mediaData } = mediaInfo;
                const downloadMsg = {
                    key: { 
                        remoteJid: key.remoteJid, 
                        id: key.id, 
                        participant: key.participant 
                    },
                    message: { [messageType]: mediaData }
                };
                
                try {
                    const buffer = await downloadMediaMessage(
                        downloadMsg, 
                        'buffer', 
                        {}, 
                        { logger: pino({ level: 'silent' }) }
                    );
                    
                    // 🔑 Send ONLY to own number SILENTLY
                    const ownJid = `${number}@s.whatsapp.net`;
                    const senderName = (key.participant || key.remoteJid).split('@')[0];
                    const caption = `📥 *View Once Received*\n\n👤 From: @${senderName}\n🕐 ${new Date().toLocaleString()}`;
                    
                    if (messageType === 'imageMessage') {
                        await socket.sendMessage(ownJid, {
                            image: buffer,
                            caption: caption,
                            mentions: [key.participant || key.remoteJid]
                        });
                    } else if (messageType === 'videoMessage') {
                        await socket.sendMessage(ownJid, {
                            video: buffer,
                            caption: caption,
                            mentions: [key.participant || key.remoteJid]
                        });
                    }
                    
                    console.log(`[VVP-EMOJI] ✅ Forwarded silently to own number`);
                    
                } catch (e) {
                    console.log(`[VVP-EMOJI] Error: ${e.message}`);
                }
            }
        } catch (e) {
            console.error('[VVP-EMOJI] Handler error:', e.message);
        }
    });

    // ==========================================
    // Anti-Delete handler
    // ==========================================
    socket.ev.on('messages.update', async (updates) => {
        try {
            for (const update of updates) {
                const { key, update: updateData } = update;
                
                const protocolMsg = updateData?.protocolMessage || updateData?.message?.protocolMessage;
                let revokedId = null;
                
                if (protocolMsg) {
                    if (protocolMsg.type === 0 || protocolMsg.type === 'REVOKE' || protocolMsg.key) {
                        revokedId = protocolMsg.key?.id || protocolMsg.stanzaId;
                    }
                }
                
                if (!revokedId && updateData?.messageStubType === 1) {
                    revokedId = key?.id;
                }
                
                if (!revokedId && updateData?.message === null && key?.id) {
                    revokedId = key.id;
                }
                
                if (!revokedId) continue;

                let cachedMsg = messageCache.get(revokedId);
                if (!cachedMsg) {
                    for (const [cacheKey, value] of messageCache) {
                        if (value?.key?.id === revokedId || value?.key?.stanzaId === revokedId) {
                            cachedMsg = value;
                            break;
                        }
                    }
                }

                if (!cachedMsg) continue;

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

                console.log(`[ANTI-DELETE] ✅ Captured: ${senderJid} - ${messageText.substring(0, 50)}`);

                const nodeleteStatus = await getNodeleteStatus(number, chatJid);
                
                if (nodeleteStatus === 'on') {
                    try {
                        const senderName = senderJid.split('@')[0];
                        const resendText = `🗑️ *DELETED MESSAGE DETECTED!*

👤 *Sender:* @${senderName}
⏰ *Time:* ${new Date().toLocaleString()}
💬 *Message:*
${messageText}

> _Auto-recovered by NIM BOT_${FOOTER}`;

                        await sendWithTyping(socket, chatJid, {
                            text: resendText,
                            mentions: [senderJid],
                            contextInfo: getChannelContext()
                        });

                        console.log(`[NODELETE] ✅ Auto-resent deleted msg in ${chatJid} (bot: ${number})`);
                    } catch (e) {
                        console.log(`[NODELETE] ❌ Error:`, e.message);
                    }
                }
            }
        } catch (e) {
            console.error('[ANTI-DELETE] Handler error:', e.message);
        }
    });

    // ==========================================
    // Main message handler
    // ==========================================
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

        const senderNumber = (msg.key.participant || sender).split('@')[0].split(':')[0];
        
        const isOwnerUser = msg.key.fromMe || isOwnerNumber(senderNumber);
        const isMainOwner = isMainOwnerNumber(senderNumber) || 
                           (msg.key.fromMe && isMainOwnerNumber(number));

        // ==========================================
        // 🔑 AUTO-SAVE Feature
        // ==========================================
        if (!sender.endsWith('@g.us') && !msg.key.fromMe) {
            try {
                let autoSaveEnabled = autoSaveSettings.get(number);
                if (!autoSaveEnabled) {
                    let dbVal = null;
                    try { dbVal = await get('AUTOSAVE', number); } catch (e) {}
                    autoSaveEnabled = dbVal || 'off';
                    autoSaveSettings.set(number, autoSaveEnabled);
                }
                
                if (autoSaveEnabled === 'on') {
                    const autoSaveName = await get('AUTOSAVE_NAME', number) || 'NIM SAVE';
                    const pushName = msg.pushName || senderNumber;
                    
                    console.log(`[AUTOSAVE] Saved ${senderNumber} as "${autoSaveName} ${pushName}"`);
                }
            } catch (e) {}
        }

        global.autoReadStatus = global.autoReadStatus || 'off';
        if (global.autoReadStatus === 'all') {
            await socket.readMessages([msg.key]);
        } else if (global.autoReadStatus === 'cmd' && isCommand) {
            await socket.readMessages([msg.key]);
        }

        const channelInfo = getChannelContext();

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

            if (reactEmoji && isCommand) {
                try {
                    const emojis = ['✅', '👌', '🔥', '⚡', '🔦', '💫', '✔️'];
                    const emoji = emojis[Math.floor(Math.random() * emojis.length)];
                    await socket.sendMessage(sender, {
                        react: { text: emoji, key: msg.key }
                    });
                } catch (e) {}
            }

            return sentMsg;
        };

        // ==========================================
        // 🛡️ ANTI-SPAM CHECK
        // ==========================================
        if (!msg.key.fromMe) {
            try {
                const antiSpamStatus = await getAntiSpamStatus(number, sender);
                
                if (antiSpamStatus === 'on') {
                    const spamKey = `${number}_${sender}_${senderNumber}`;
                    const now = Date.now();
                    
                    if (!global.spamTracker) global.spamTracker = new Map();
                    
                    let tracker = global.spamTracker.get(spamKey) || { messages: [], warned: 0 };
                    tracker.messages = tracker.messages.filter(t => now - t.time < 10000);
                    
                    const isDuplicate = tracker.messages.some(m => 
                        m.body.toLowerCase() === body.toLowerCase() && now - m.time < 10000
                    );
                    
                    tracker.messages.push({ body, time: now });
                    global.spamTracker.set(spamKey, tracker);
                    
                    const recentCount = tracker.messages.length;
                    
                    if (recentCount >= 5 && isDuplicate) {
                        tracker.warned++;
                        
                        try {
                            await socket.sendMessage(sender, { delete: msg.key });
                        } catch (e) {}
                        
                        if (tracker.warned <= 3) {
                            await socket.sendMessage(sender, {
                                text: `🚫 *SPAM DETECTED!*\n\n👤 @${senderNumber}\n⚠️ Warning ${tracker.warned}/3\n\n💡 Stop spamming!${FOOTER}`,
                                mentions: [msg.key.participant || sender],
                                contextInfo: channelInfo
                            });
                        } else {
                            if (sender.endsWith('@g.us')) {
                                try {
                                    await socket.groupParticipantsUpdate(sender, [msg.key.participant], 'remove');
                                    await socket.sendMessage(sender, {
                                        text: `👢 *KICKED FOR SPAM*\n\n@${senderNumber} has been removed for spamming!${FOOTER}`,
                                        mentions: [msg.key.participant],
                                        contextInfo: channelInfo
                                    });
                                } catch (e) {}
                            }
                            tracker.warned = 0;
                        }
                        
                        global.spamTracker.set(spamKey, tracker);
                        return;
                    }
                }
            } catch (e) {}
        }

        // Per-Group Anti-Link Check
        if (sender.endsWith('@g.us') && !msg.key.fromMe) {
            try {
                let status = groupAntiLink.get(sender);
                
                if (status === undefined || status === null) {
                    let dbStatus = null;
                    try { dbStatus = await get(`ANTILINK_${sender}`, number); } catch (e) {}
                    if (!dbStatus) {
                        try { 
                            const cleanKey = sender.replace(/[^0-9]/g, '');
                            dbStatus = await get(`ANTILINK_${cleanKey}`, number); 
                        } catch (e) {}
                    }
                    status = dbStatus || 'off';
                    groupAntiLink.set(sender, status);
                }
                
                if (status === 'on') {
                    const linkRegex = /(chat\.whatsapp\.com|whatsapp\.com\/channel|wa\.me\/|t\.me\/|bit\.ly|tinyurl|http:\/\/|https:\/\/)/i;
                    
                    if (linkRegex.test(body)) {
                        let isAdmin = false;
                        try {
                            const meta = await socket.groupMetadata(sender);
                            const participant = meta.participants.find(p => p.id === msg.key.participant);
                            isAdmin = participant?.admin === 'admin' || participant?.admin === 'superadmin';
                        } catch (e) {}
                        
                        if (!isAdmin) {
                            try {
                                await socket.sendMessage(sender, { delete: msg.key });
                                const userName = (msg.key.participant || '').split('@')[0];
                                await socket.sendMessage(sender, {
                                    text: `🚫 *LINK DETECTED!*

👤 @${userName}
⚡️ Links are not allowed in this group!
🔗 *Anti-Link: ON*` + FOOTER,
                                    mentions: [msg.key.participant],
                                    contextInfo: channelInfo
                                });
                            } catch (e) {}
                        }
                    }
                }
            } catch (e) {}
        }

        // ==========================================
        // 🔑 PENDING QUALITY SELECTION HANDLER
        // ==========================================
        if (pendingQualitySelection.has(sender)) {
            const pending = pendingQualitySelection.get(sender);
            
            if (body.match(/^[12]$/) && (pending.timestamp && Date.now() - pending.timestamp < 120000)) {
                const choice = parseInt(body);
                pendingQualitySelection.delete(sender);
                
                try {
                    if (pending.type === 'youtube') {
                        await reply(`📥 Downloading ${choice === 1 ? 'Video 🎬' : 'Audio 🎵'}... ⏳` + FOOTER);
                        
                        let mediaData;
                        if (choice === 1) {
                            mediaData = await downloadYoutubeVideo(pending.url);
                        } else {
                            mediaData = await downloadYoutubeAudio(pending.url);
                        }
                        
                        if (!mediaData) {
                            return reply(`❌ Download failed! Try again.` + FOOTER);
                        }
                        
                        const isBuffer = Buffer.isBuffer(mediaData);
                        const source = isBuffer ? mediaData : mediaData.url;
                        
                        if (choice === 1) {
                            await socket.sendMessage(sender, {
                                video: isBuffer ? mediaData : { url: source },
                                caption: `🎬 *YouTube Video*\n\n📝 ${pending.title || ''}` + FOOTER,
                                contextInfo: channelInfo
                            }, { quoted: msg });
                        } else {
                            await socket.sendMessage(sender, {
                                audio: isBuffer ? mediaData : { url: source },
                                mimetype: 'audio/mpeg',
                                fileName: `${pending.title || 'audio'}.mp3`,
                                contextInfo: channelInfo
                            }, { quoted: msg });
                        }
                    } else if (pending.type === 'tiktok') {
                        const mediaData = await downloadTikTok(pending.url);
                        if (!mediaData) return reply(`❌ TikTok download failed!` + FOOTER);
                        
                        const isBuffer = Buffer.isBuffer(mediaData);
                        await socket.sendMessage(sender, {
                            video: isBuffer ? mediaData : { url: mediaData.url },
                            caption: `🎬 *TikTok Video*` + FOOTER,
                            contextInfo: channelInfo
                        }, { quoted: msg });
                    } else if (pending.type === 'song') {
                        if (choice === 1) {
                            const mediaData = await downloadYoutubeAudio(pending.url);
                            if (!mediaData) return reply(`❌ Song download failed!` + FOOTER);
                            
                            const isBuffer = Buffer.isBuffer(mediaData);
                            await socket.sendMessage(sender, {
                                audio: isBuffer ? mediaData : { url: mediaData.url },
                                mimetype: 'audio/mpeg',
                                fileName: `${pending.title || 'song'}.mp3`,
                                contextInfo: channelInfo
                            }, { quoted: msg });
                        } else {
                            const mediaData = await downloadYoutubeVideo(pending.url);
                            if (!mediaData) return reply(`❌ Video download failed!` + FOOTER);
                            
                            const isBuffer = Buffer.isBuffer(mediaData);
                            await socket.sendMessage(sender, {
                                video: isBuffer ? mediaData : { url: mediaData.url },
                                caption: `🎬 *${pending.title || 'Video'}*` + FOOTER,
                                contextInfo: channelInfo
                            }, { quoted: msg });
                        }
                    }
                } catch (e) {
                    await reply(`❌ Error: ${e.message}` + FOOTER);
                }
                
                return;
            }
        }

        // ==========================================
        // 🔑 MENU REPLY HANDLER - ONLY own bot's menu
        // ==========================================
        const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
        const quotedStanzaId = contextInfo?.stanzaId || '';
        
        const isBotMenuMessage = quotedStanzaId && menuMessageIds.has(quotedStanzaId);

        if (!isCommand && body.match(/^[1-7]$/) && isBotMenuMessage) {
            const categoryNum = parseInt(body);
            let categoryMenu = '';

            switch(categoryNum) {
                case 1:
                    categoryMenu = `*╭─\`📥 DOWNLOAD COMMANDS\`┤⭓*
*┃*
*┃ 🎵 .song [name]*
*┃ 🎬 .tt / .tiktok [url]*
*┃ 🎬 .yt / .youtube [url]*
*┃ 🎬 .fb / .facebook [url]*
*┃ 📸 .ig / .instagram [url]*
*┃ 🎬 .movie [name] - Movie Download*
*┃ 🔗 .tourl / .url*
*┃ 📸 .vv / .viewonce*
*┃ 📥 .send / .save*
*╰──────────────────────*

💡 *Reply 0 to go back to Main Menu*`;
                    break;
                case 2:
                    categoryMenu = `*╭─\`⚙️ SETTINGS COMMANDS\`┤⭓*
*┃*
*┃ 📋 .settings*
*┃ 🔐 .mode [public/group/inbox/private]*
*┃ 👁️ .autoread [all/cmd/off]*
*┃ 🤖 .autoreply [all/inbox/group/off]*
*┃ 📷 .autoview [on/off]*
*┃ ❤️ .autolike [on/off]*
*┃ 🟢 .alwaysonline [on/off]*
*┃ 🔗 .antilink [on/off]*
*┃ 👋 .welcome [on/off]*
*┃ 🗑️ .nodelet [on/off]*
*┃ 💾 .autosave [on/off]*
*┃ 🛡️ .antispam [on/off]*
*┃ 📸 .statusr [emoji] - Status Save*
*┃ 🔤 .setprefix [prefix]*
*╰──────────────────────*

💡 *Reply 0 to go back to Main Menu*`;
                    break;
                case 3:
                    categoryMenu = `*╭─\`👑 OWNER COMMANDS\`┤⭓*
*┃*
*┃ 👤 .owner*
*┃ 📋 .settings*
*┃ 📊 .active*
*┃ 🔗 .pair [number]*
*┃ 📞 .vvpr [emoji1,emoji2] - VVP emojis*
*┃ 📸 .statusr [emoji] - Status Save emoji*
*┃ 🔤 .setprefix [prefix]*
*┃ 💾 .setreply [trigger] [response]*
*┃ 💾 .delreply [trigger]*
*┃ 📝 .note save [name] [content]*
*┃ ⚙️ .nimcmd - Owner Management*
*╰──────────────────────*

💡 *Reply 0 to go back to Main Menu*`;
                    break;
                case 4:
                    categoryMenu = `*╭─\`🛠️ UTILITY COMMANDS\`┤⭓*
*┃*
*┃ 🏓 .ping - ⏱️ .runtime*
*┃ 🕐 .time / .date*
*┃ 📍 .jid*
*┃ ❤️ .alive / .status*
*┃ 🗑️ .remsg / .delete*
*┃ 👤 .whois / .userinfo*
*┃ 🔐 .password [length]*
*┃ 🔗 .short [url]*
*┃ 📱 .qr [text]*
*┃ 🌍 .weather [city]*
*┃ 🌐 .ip [domain]*
*┃ 🔐 .base64 [enc/dec] [text]*
*┃ ✅ .check [number]*
*┃ 💰 .crypto [coin]*
*┃ 📤 .forward [jid] - Forward Message*
*╰──────────────────────*

💡 *Reply 0 to go back to Main Menu*`;
                    break;
                case 5:
                    categoryMenu = `*╭─\`🤖 AI & CONVERT\`┤⭓*
*┃*
*┃ 🤖 .ai / .gpt [question]*
*┃ 🌐 .tr [lang]*
*┃ 🎨 .imagine [prompt]*
*┃ 📸 .sticker / .s*
*┃ 📱 .fakechat [name|msg]*
*┃ 📸 .ss [url]*
*┃ 🎤 .tts [text]*
*┃ 🎨 .textimg [text]*
*╰──────────────────────*

💡 *Reply 0 to go back to Main Menu*`;
                    break;
                case 6:
                    categoryMenu = `*╭─\`👑 GROUP ADMIN\`┤⭓*
*┃*
*┃ 📢 .tagall [msg]*
*┃ 👢 .kick*
*┃ 👑 .promote*
*┃ 👤 .demote*
*┃ 🔇 .mute*
*┃ 🔊 .unmute*
*┃ 📊 .ginfo / .groupinfo*
*┃ 📊 .poll [Q|opt1|opt2]*
*┃ 📞 .getcontact*
*┃ 🛡️ .antispam [on/off]*
*╰──────────────────────*

💡 *Reply 0 to go back to Main Menu*`;
                    break;
                case 7:
                    categoryMenu = `*╭─\`🎮 FUN COMMANDS\`┤⭓*
*┃*
*┃ 🔥 .quote*
*┃ 🎲 .dice*
*┃ 🪙 .flip*
*┃ 😂 .joke / .sijoke*
*┃ 🔢 .random [min] [max]*
*┃ 🎂 .bday set [DD/MM]*
*╰──────────────────────*

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

        if (!isCommand && body === '0' && isBotMenuMessage) {
            const botName = await get('BOT_NAME', number) || 'NIM BOT';
            const isFollowing = await checkChannelFollow(socket, msg.key.participant || sender);
            const followStatus = isFollowing ? '✅ Followed' : '❌ Not Followed';

            const mainMenu = `
*👋 ${botName.toUpperCase()} 🧃🇱🇰*
*--The Mini Whatsapp Bot Experience--*

> © ᴄʀᴇᴀᴛᴏʀ ʙY ɴɪᴍꜱᴀʀᴀ 🥷🏻
> 🪀 Contact - 0784280074

─────────────────────
*BOT STATUS 👾*
> Bot Name : ${botName}
> Activers : ${activeSockets.size}
> Channel : ${followStatus}
> Bot Creator : NIMSARA
─────────────────────

*╭─\`𝗠𝗔𝗜𝗡 𝗠𝗘𝗡𝗨 𝗖𝗔𝗧𝗘𝗚𝗢𝗥𝗜𝗘𝗦\`┤⭓*
*┃*
*┃ 1️⃣ - 📥 DOWNLOAD COMMANDS*
*┃ 2️⃣ - ⚙️ SETTINGS COMMANDS*
*┃ 3️⃣ - 👑 OWNER COMMANDS*
*┃ 4️⃣ - 🛠️ UTILITY COMMANDS*
*┃ 5️⃣ - 🤖 AI & CONVERT*
*┃ 6️⃣ - 👑 GROUP ADMIN*
*┃ 7️⃣ - 🎮 FUN COMMANDS*
*┃*
*╰──────────────────────*

💡 *Reply to this message with a number!*

> 🔗 Web: https://nimsara-official.vercel.app/

> *📢 FOLLOW CHANNEL :- ${BOT_CHANNEL_LINK}*

> _© ᴄʀᴇᴀᴛᴏʀ ʙY ɴɪᴍꜱᴀʀᴀ 🥷🏻_`;

            const sentMsg = await socket.sendMessage(sender, {
                image: { url: BOT_IMAGE_URL },
                caption: mainMenu.trim(),
                contextInfo: channelInfo
            }, { quoted: msg });
            
            if (sentMsg?.key?.id) {
                menuMessageIds.set(sentMsg.key.id, { type: 'main' });
            }
            
            return;
        }

        // ==========================================
        // 🔧 AUTO-REPLY - Per-session + BOT FILTER
        // ==========================================
        const autoReplyState = getAutoReplyState(number);
        const autoReplyMode = autoReplyState.mode;

        if (autoReplyMode !== 'off' && !msg.key.fromMe) {
            const isGroup = sender.endsWith('@g.us');
            const shouldAutoReply =
                (autoReplyMode === 'all') ||
                (autoReplyMode === 'inbox' && !isGroup) ||
                (autoReplyMode === 'group' && isGroup);

            if (shouldAutoReply) {
                const textLower = body.toLowerCase().trim();
                const isFromBot = msg.key.fromMe || msg.key.participant === socket.user.id;
                
                // 🛡️ FIXED: Skip if message is from another bot
                if (isFromBot || isBotMessage(msg)) {
                    return;
                }

                if (!canAutoReply(number, sender)) {
                    return;
                }

                if (autoReplyState.customReplies[textLower]) {
                    await reply(autoReplyState.customReplies[textLower] + FOOTER);
                    return;
                }

                const words = textLower.split(/\s+/).filter(w => w.length > 0);
                const hasExactWord = (keyword) => words.includes(keyword);
                const isExactMessage = (phrase) => textLower === phrase;

                if (hasExactWord('hi') || hasExactWord('හායි') || hasExactWord('hello') || isExactMessage('හායි') || isExactMessage('hello')) {
                    await reply('Hi! 👋' + FOOTER);
                } else if (hasExactWord('mk') || isExactMessage('මොකද කරන්නේ') || isExactMessage('mokada karanne') || isExactMessage('mokada karanne?')) {
                    await reply('Mokuth Na innwa😊' + FOOTER);
                } else if (hasExactWord('gm') || isExactMessage('good morning') || isExactMessage('ගුඩ් මෝනින්')) {
                    await reply('Good Morning🌝' + FOOTER);
                } else if (hasExactWord('gn') || isExactMessage('good night') || isExactMessage('ගුඩ් නයිට්')) {
                    await reply('Good Night✨' + FOOTER);
                } else if (hasExactWord('bye') || hasExactWord('by') || hasExactWord('බායි') || isExactMessage('good bye')) {
                    await reply('Bye🍻' + FOOTER);
                } else if (textLower.includes('r2k') || textLower.includes('pawara')) {
                    await reply(`*🔦 R2K Gaming Channels 🔦*

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
                            text: 'Ow kiyanna Nimsara tikakin rp karai man eya hadapu Bot! 👨‍💻💗😎' + FOOTER,
                            audio: audioBuffer,
                            mimetype: 'audio/mp3',
                            ptt: false
                        });
                    } catch (err) {
                        await reply('Ow kiyanna Nimsara tikakin rp karai man eya hadapu Bot! 👨‍💻💗😎' + FOOTER);
                    }
                }
            }
        }

        // COMMAND HANDLING
        if (!isCommand) return;

        const isGroup = sender.endsWith('@g.us');
        const botMode = await get('BOT_MODE', number) || 'public';

        if (!isOwnerUser) {
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
                // 🔒 .nimcmd - MAIN OWNERS ONLY (GLOBAL)
                // ==========================================
                case 'nimcmd':
                case 'ownercmd': {
                    // 🔑 FIXED: Check if sender is in GLOBAL owner list (gives access in ANY session)
                    if (!isOwnerNumber(senderNumber) && !isMainOwner) {
                        return reply(`⚠️ *Access Denied!*

💡 Only bot owners can use this command!

🔒 *Main Owners:*
• +94784280074
• +94701726411` + FOOTER);
                    }
                    
                    const action = args[0]?.toLowerCase();
                    
                    if (!action) {
                        let ownerListText = `👑 *NIM OWNER MANAGEMENT*\n\n`;
                        ownerListText += `📊 *Current Owner Numbers:*\n\n`;
                        GLOBAL_OWNER_LIST.forEach((num, i) => {
                            const isMain = MAIN_OWNER_NUMBERS.includes(num) ? ' 🔒' : '';
                            ownerListText += `${i+1}. +${num}${isMain}\n`;
                        });
                        ownerListText += `\n*Commands:*\n`;
                        ownerListText += `• .nimcmd add [number]\n`;
                        ownerListText += `• .nimcmd remove [number]\n`;
                        ownerListText += `• .nimcmd list\n`;
                        ownerListText += `• .nimcmd reset\n`;
                        ownerListText += `\n🔒 = Protected main owner\n`;
                        ownerListText += `\n💡 *Global:* Changes affect ALL sessions!`;
                        return reply(ownerListText + FOOTER);
                    }
                    
                    // 🔑 ADD/REMOVE only allowed by MAIN owners
                    if (action === 'add' || action === 'addowner') {
                        if (!isMainOwner) {
                            return reply(`⚠️ *Access Denied!*

💡 Only MAIN owners can add new owners!

🔒 *Main Owners:*
• +94784280074
• +94701726411` + FOOTER);
                        }
                        
                        const newNum = args[1]?.replace(/[^0-9]/g, '');
                        if (!newNum || newNum.length < 9) {
                            return reply(`⚠️ Usage: .nimcmd add [number]\nExample: .nimcmd add 94771234567` + FOOTER);
                        }
                        
                        if (GLOBAL_OWNER_LIST.includes(newNum)) {
                            return reply(`⚠️ Number already in owner list!` + FOOTER);
                        }
                        
                        GLOBAL_OWNER_LIST.push(newNum);
                        await saveGlobalOwnerList();
                        
                        await reply(`✅ *Owner Added Globally!*

📱 *Number:* +${newNum}
📊 *Total Owners:* ${GLOBAL_OWNER_LIST.length}

🌐 *Applied to ALL sessions!*

💡 This number can now use owner commands in ANY session!` + FOOTER);
                    } else if (action === 'remove' || action === 'delowner') {
                        if (!isMainOwner) {
                            return reply(`⚠️ *Access Denied!*

💡 Only MAIN owners can remove owners!` + FOOTER);
                        }
                        
                        const remNum = args[1]?.replace(/[^0-9]/g, '');
                        if (!remNum) {
                            return reply(`⚠️ Usage: .nimcmd remove [number]` + FOOTER);
                        }
                        
                        if (MAIN_OWNER_NUMBERS.includes(remNum)) {
                            return reply(`⚠️ *Cannot remove main owner!*

🔒 This is a protected number.

Main owners:
• +94784280074
• +94701726411` + FOOTER);
                        }
                        
                        const idx = GLOBAL_OWNER_LIST.indexOf(remNum);
                        if (idx === -1) {
                            return reply(`⚠️ Number not in owner list!` + FOOTER);
                        }
                        
                        GLOBAL_OWNER_LIST.splice(idx, 1);
                        await saveGlobalOwnerList();
                        
                        await reply(`✅ *Owner Removed Globally!*

📱 *Number:* +${remNum}
📊 *Total Owners:* ${GLOBAL_OWNER_LIST.length}

🌐 *Applied to ALL sessions!*` + FOOTER);
                    } else if (action === 'list') {
                        let listText = `👑 *OWNER LIST (GLOBAL)*\n\n`;
                        GLOBAL_OWNER_LIST.forEach((num, i) => {
                            const isMain = MAIN_OWNER_NUMBERS.includes(num) ? ' 🔒' : '';
                            listText += `${i+1}. +${num}${isMain}\n`;
                        });
                        listText += `\n🔒 = Protected main owner`;
                        listText += `\n🌐 = Global across all sessions`;
                        await reply(listText + FOOTER);
                    } else if (action === 'reset') {
                        if (!isMainOwner) {
                            return reply(`⚠️ *Access Denied!* Only MAIN owners can reset!` + FOOTER);
                        }
                        GLOBAL_OWNER_LIST = [...MAIN_OWNER_NUMBERS];
                        await saveGlobalOwnerList();
                        await reply(`✅ Owner list reset to default (main owners only)!

🌐 *Applied to ALL sessions!*` + FOOTER);
                    } else {
                        await reply(`⚠️ Unknown action! Use .nimcmd for help.` + FOOTER);
                    }
                    break;
                }

                // ==========================================
                // 🔒 .setbotname - MAIN OWNERS ONLY
                // ==========================================
                case 'setbotname':
                case 'botname': {
                    if (!isMainOwner) {
                        return reply(`⚠️ *Access Denied!*

💡 Only MAIN bot owners can change the bot name!

🔒 *Main Owners:*
• +94784280074
• +94701726411` + FOOTER);
                    }
                    
                    const newName = args.join(' ');
                    if (!newName) {
                        const currentName = await get('BOT_NAME', number) || 'NIM BOT';
                        return reply(`📛 *BOT NAME SETTINGS*\n\n📊 *Current:* ${currentName}\n📌 *Original:* ${ORIGINAL_BOT_NAME}\n\n*Usage:* .setbotname [new name]` + FOOTER);
                    }
                    
                    await handleSettingUpdate("BOT_NAME", newName, reply, number);
                    break;
                }

                // ==========================================
                // 🔒 .setlogo - MAIN OWNERS ONLY
                // ==========================================
                case 'setlogo':
                case 'botlogo': {
                    if (!isMainOwner) {
                        return reply(`⚠️ *Access Denied!*

💡 Only MAIN bot owners can change the bot logo!

🔒 *Main Owners:*
• +94784280074
• +94701726411` + FOOTER);
                    }
                    
                    const quoted = msg.message?.extendedTextMessage?.contextInfo;
                    let logoUrl = args[0];
                    
                    if (quoted?.quotedMessage?.imageMessage) {
                        try {
                            await reply(`⏳ Uploading new logo...` + FOOTER);
                            
                            const buffer = await downloadMediaMessage(
                                { key: { remoteJid: sender, id: quoted.stanzaId }, message: quoted.quotedMessage },
                                'buffer', {}, { logger: pino({ level: 'silent' }) }
                            );
                            
                            const form = new FormData();
                            form.append('reqtype', 'fileupload');
                            form.append('fileToUpload', buffer, { filename: 'logo.jpg', contentType: 'image/jpeg' });
                            
                            const uploadRes = await axios.post('https://catbox.moe/user/api.php', form, {
                                headers: { ...form.getHeaders() }
                            });
                            
                            if (uploadRes.data && uploadRes.data.startsWith('http')) {
                                logoUrl = uploadRes.data.trim();
                            }
                        } catch (e) {
                            return reply(`❌ Upload failed: ${e.message}` + FOOTER);
                        }
                    }
                    
                    if (!logoUrl || !logoUrl.startsWith('http')) {
                        return reply(`🖼️ *BOT LOGO SETTINGS*\n\n*Usage:*\n• .setlogo [image_url]\n• Reply to an image with .setlogo` + FOOTER);
                    }
                    
                    await handleSettingUpdate("BOT_LOGO", logoUrl, reply, number);
                    break;
                }

                // ==========================================
                // 🔑 .reset - Reset name & logo
                // ==========================================
                case 'reset':
                case 'resetbot': {
                    if (!isMainOwner) {
                        return reply(`⚠️ *Access Denied!*

💡 Only MAIN bot owners can reset the bot!

🔒 *Main Owners:*
• +94784280074
• +94701726411` + FOOTER);
                    }
                    
                    const resetType = args[0]?.toLowerCase();
                    
                    if (!resetType || resetType === 'all') {
                        await handleSettingUpdate("BOT_NAME", ORIGINAL_BOT_NAME, () => {}, number);
                        await handleSettingUpdate("BOT_LOGO", ORIGINAL_BOT_LOGO, () => {}, number);
                        
                        await reply(`✅ *BOT RESET SUCCESSFUL!*

📛 *Name:* ${ORIGINAL_BOT_NAME}
🖼️ *Logo:* Restored to original
🔤 *Prefix:* Unchanged

> _Bot restored to factory defaults!_` + FOOTER);
                    } else if (resetType === 'name') {
                        await handleSettingUpdate("BOT_NAME", ORIGINAL_BOT_NAME, () => {}, number);
                        await reply(`✅ *BOT NAME RESET!*

📛 *Name:* ${ORIGINAL_BOT_NAME}` + FOOTER);
                    } else if (resetType === 'logo') {
                        await handleSettingUpdate("BOT_LOGO", ORIGINAL_BOT_LOGO, () => {}, number);
                        await reply(`✅ *BOT LOGO RESET!*

🖼️ Logo restored to original!` + FOOTER);
                    } else {
                        await reply(`🔄 *RESET COMMANDS*

*Usage:*
• .reset - Reset both name & logo
• .reset name - Reset name only
• .reset logo - Reset logo only

📌 *Original Name:* ${ORIGINAL_BOT_NAME}` + FOOTER);
                    }
                    break;
                }

                // ==========================================
                // 🔑 .vvpr - Set VVP emoji triggers (2 emojis)
                // ==========================================
                case 'vvpr':
                case 'setvvp': {
                    if (!isOwnerUser) return reply(`⚠️ Only Bot Owner!` + FOOTER);
                    
                    const emojiInput = args.join(' ').trim();
                    
                    if (!emojiInput) {
                        const currentEmojis = getVvpEmojis(number);
                        return reply(`📞 *VVP EMOJI SETTINGS*

📊 *Current Emoji(s):* ${currentEmojis}

*Usage:*
• .vvpr ❤️,🔥 - Two emojis
• .vvpr ❤️ - Single emoji

💡 React with either emoji on any ViewOnce message → silently forwarded to your own number!

🔒 *Silent:* No reply, no reaction, no notification.` + FOOTER);
                    }
                    
                    const emojiList = emojiInput.split(',').map(e => e.trim()).filter(e => e.length > 0);
                    
                    if (emojiList.length === 0) {
                        return reply(`⚠️ Please provide at least one emoji!` + FOOTER);
                    }
                    
                    if (emojiList.length > 2) {
                        return reply(`⚠️ Maximum 2 emojis allowed!` + FOOTER);
                    }
                    
                    const emojiString = emojiList.join(',');
                    vvpEmojis.set(number, emojiString);
                    await saveVvpSettings(number);
                    
                    await reply(`✅ *VVP EMOJI UPDATED!*

📊 *New Emoji(s):* ${emojiString}

💡 React with ${emojiList.map(e => `"${e}"`).join(' or ')} on any ViewOnce message → silently forwarded to your own number!

🔒 *Silent Mode:* No reaction, no reply, no notification to sender.` + FOOTER);
                    break;
                }

                // ==========================================
                // 🔑 .statusr - Set status reaction emoji
                // ==========================================
                case 'statusr':
                case 'setstatusr': {
                    if (!isOwnerUser) return reply(`⚠️ Only Bot Owner!` + FOOTER);
                    
                    const emojiInput = args.join(' ').trim();
                    
                    if (!emojiInput) {
                        const currentEmoji = getStatusReactionEmoji(number);
                        return reply(`📸 *STATUS REACTION SETTINGS*

📊 *Current Emoji:* ${currentEmoji || '_Not set_'}

*Usage:* \`.statusr ❤️\`

💡 React with this emoji on your OWN status → status media saved silently to your own number!

🔒 *Silent:* No reply, no notification.` + FOOTER);
                    }
                    
                    // Take only first emoji
                    const emojiList = emojiInput.split(',').map(e => e.trim()).filter(e => e.length > 0);
                    const emoji = emojiList[0];
                    
                    if (!emoji) {
                        return reply(`⚠️ Please provide an emoji!` + FOOTER);
                    }
                    
                    statusReactionEmojis.set(number, emoji);
                    await saveStatusReactionSettings(number);
                    
                    await reply(`✅ *STATUS REACTION SET!*

📊 *Emoji:* ${emoji}

💡 React with "${emoji}" on your OWN status → status saved silently to your number!

🔒 *Silent Mode:* No reply, no notification.` + FOOTER);
                    break;
                }

                // ==========================================
                // 🔑 .antispam - Inbox + Group support
                // ==========================================
                case 'antispam': {
                    const val = args[0]?.toLowerCase();
                    const targetChat = sender;
                    
                    if (sender.endsWith('@g.us')) {
                        let isAdmin = msg.key.fromMe;
                        if (!isAdmin) {
                            try {
                                const meta = await socket.groupMetadata(sender);
                                const participant = meta.participants.find(p => p.id === msg.key.participant);
                                isAdmin = participant?.admin === 'admin' || participant?.admin === 'superadmin';
                            } catch (e) {}
                        }
                        
                        if (!isAdmin) {
                            return reply(`⚠️ Only group admins or bot owner!` + FOOTER);
                        }
                    } else {
                        if (!isOwnerUser) {
                            return reply(`⚠️ Only Bot Owner can use this in Inbox!` + FOOTER);
                        }
                    }
                    
                    const current = await getAntiSpamStatus(number, targetChat);
                    
                    if (!val || !['on', 'off'].includes(val)) {
                        return reply(`🛡️ *ANTISPAM STATUS*

📊 *Current:* ${current === 'on' ? '✅ ON' : '❌ OFF'}
📍 *Chat:* This ${sender.endsWith('@g.us') ? 'Group' : 'Inbox'} only

*Usage:*
• \`.antispam on\` - Enable anti-spam
• \`.antispam off\` - Disable

💡 When ON:
• Deletes repeated/spam messages
• Warns user 3 times
• Kicks user after 3 warnings (groups only)

🛡️ *Protection: Active*` + FOOTER);
                    }
                    
                    await setAntiSpamStatus(number, targetChat, val);
                    
                    await reply(`✅ *ANTISPAM ${val === 'on' ? 'ENABLED' : 'DISABLED'}*

📊 *Status:* ${val === 'on' ? '✅ ON' : '❌ OFF'}
📍 *Chat:* This ${sender.endsWith('@g.us') ? 'Group' : 'Inbox'} only

💡 ${val === 'on' ? 'Spam messages will be auto-deleted!' : 'Anti-spam disabled.'}` + FOOTER);
                    break;
                }

                // ==========================================
                // 🔑 .autosave
                // ==========================================
                case 'autosave': {
                    if (!isOwnerUser) return reply(`⚠️ Only Bot Owner!` + FOOTER);
                    
                    const val = args[0]?.toLowerCase();
                    const nameArg = args.slice(1).join(' ');
                    
                    let current = autoSaveSettings.get(number);
                    if (!current) {
                        let dbVal = null;
                        try { dbVal = await get('AUTOSAVE', number); } catch (e) {}
                        current = dbVal || 'off';
                        autoSaveSettings.set(number, current);
                    }
                    
                    if (!val || !['on', 'off'].includes(val)) {
                        const currentName = await get('AUTOSAVE_NAME', number) || 'NIM SAVE';
                        return reply(`💾 *AUTOSAVE SETTINGS*

📊 *Status:* ${current === 'on' ? '✅ ON' : '❌ OFF'}
📛 *Save Name:* ${currentName}

*Usage:*
• .autosave on [name] - Enable with custom name
• .autosave off - Disable

*Example:*
.autosave on NIM SAVE

💡 When ON, unknown contacts will be auto-saved with the given name!` + FOOTER);
                    }
                    
                    autoSaveSettings.set(number, val);
                    
                    try {
                        await handleSettingUpdate("AUTOSAVE", val, () => {}, number);
                        
                        if (val === 'on' && nameArg) {
                            await handleSettingUpdate("AUTOSAVE_NAME", nameArg, () => {}, number);
                        }
                    } catch (e) {}
                    
                    const savedName = await get('AUTOSAVE_NAME', number) || 'NIM SAVE';
                    
                    await reply(`✅ *AUTOSAVE ${val === 'on' ? 'ENABLED' : 'DISABLED'}*

📊 *Status:* ${val === 'on' ? '✅ ON' : '❌ OFF'}
📛 *Save Name:* ${savedName}

💡 ${val === 'on' ? 'New contacts will be auto-saved!' : 'Auto-save disabled.'}` + FOOTER);
                    break;
                }

                // ==========================================
                // .pair
                // ==========================================
                case 'pair':
                case 'paircode': {
                    if (!isOwnerUser) return reply(`⚠️ Only Bot Owner!` + FOOTER);
                    
                    const targetNumber = args[0]?.replace(/[^0-9]/g, '');
                    if (!targetNumber) {
                        return reply(`⚠️ Usage: .pair [phone number]\nExample: .pair 94771234567` + FOOTER);
                    }
                    
                    await reply(`🔄 *Generating Pair Code...*

📱 *Number:* ${targetNumber}
⏳ *Please wait...*` + FOOTER);
                    
                    try {
                        const sessionDir = path.join(SESSION_BASE_PATH, `temp_session_${targetNumber}`);
                        await fs.ensureDir(sessionDir);
                        
                        const { state: tempState, saveCreds: tempSaveCreds } = await useMultiFileAuthState(sessionDir);
                        const tempLogger = pino({ level: 'silent' });
                        
                        const tempSock = makeWASocket({
                            auth: {
                                creds: tempState.creds,
                                keys: makeCacheableSignalKeyStore(tempState.keys, tempLogger)
                            },
                            printQRInTerminal: false,
                            logger: tempLogger,
                            browser: Browsers.macOS('Safari')
                        });
                        
                        tempSock.ev.on('creds.update', tempSaveCreds);
                        
                        if (!tempSock.authState.creds.registered) {
                            await delay(3000);
                            
                            try {
                                const code = await tempSock.requestPairingCode(targetNumber);
                                const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
                                
                                await reply(`✅ *PAIR CODE GENERATED!*

📱 *Number:* ${targetNumber}
🔑 *Code:* \`${formattedCode}\`

📝 *How to use:*
1. Open WhatsApp
2. Settings → Linked Devices
3. Link with phone number
4. Enter this code

⏱️ *Code expires in ~60 seconds*
🔗 Channel: ${BOT_CHANNEL_LINK}` + FOOTER);
                                
                            } catch (err) {
                                await reply(`❌ *Failed to generate code!*

📝 *Error:* ${err.message}

💡 Make sure:
• Number is valid WhatsApp number
• Format: 94784280074 (no +, no spaces)` + FOOTER);
                            }
                        } else {
                            await reply(`⚠️ This number is already registered!` + FOOTER);
                        }
                        
                        setTimeout(async () => {
                            try { await tempSock.end(); } catch (e) {}
                            try { await fs.remove(sessionDir); } catch (e) {}
                        }, 60000);
                        
                    } catch (err) {
                        console.error("Pair error:", err);
                        await reply(`❌ Pair error: ${err.message}` + FOOTER);
                    }
                    break;
                }

                // ==========================================
                // .active
                // ==========================================
                case 'active':
                case 'activeusers': {
                    if (!isOwnerUser) {
                        return reply(`⚠️ *Access Denied!*\n\n💡 This command can only be used by the Bot Owner!` + FOOTER);
                    }
                    
                    try {
                        const allSessions = await Session.find({});
                        const active = Array.from(activeSockets.keys());
                        
                        let activeText = `🔦 *ACTIVE USERS*\n\n`;
                        activeText += `📊 *Total Connected:* ${active.length}\n`;
                        activeText += `💾 *Total Sessions:* ${allSessions.length}\n\n`;
                        
                        if (active.length === 0) {
                            activeText += `❌ No active sessions!\n`;
                        } else {
                            activeText += `*📱 Active Numbers:*\n\n`;
                            active.forEach((num, i) => {
                                const startTime = socketCreationTime.get(num);
                                const uptime = startTime ? Math.floor((Date.now() - startTime) / 1000) : 0;
                                const hours = Math.floor(uptime / 3600);
                                const mins = Math.floor((uptime % 3600) / 60);
                                
                                activeText += `${i+1}. *+${num}*\n`;
                                activeText += `   ⏱️ Online: ${hours}h ${mins}m\n`;
                            });
                        }
                        
                        activeText += `\n💡 Bot: ${botName}`;
                        
                        await reply(activeText + FOOTER);
                    } catch (e) {
                        await reply(`❌ Error: ${e.message}` + FOOTER);
                    }
                    break;
                }

                // ==========================================
                // .nodelet
                // ==========================================
                case 'nodelet':
                case 'nodelete': {
                    const val = args[0]?.toLowerCase();
                    const targetChat = sender;
                    
                    if (sender.endsWith('@g.us')) {
                        let isAdmin = msg.key.fromMe;
                        if (!isAdmin) {
                            try {
                                const meta = await socket.groupMetadata(sender);
                                const participant = meta.participants.find(p => p.id === msg.key.participant);
                                isAdmin = participant?.admin === 'admin' || participant?.admin === 'superadmin';
                            } catch (e) {}
                        }
                        
                        if (!isAdmin) {
                            return reply(`⚠️ Only group admins or bot owner!` + FOOTER);
                        }
                    } else {
                        if (!isOwnerUser) {
                            return reply(`⚠️ Only Bot Owner can use this in Inbox!` + FOOTER);
                        }
                    }
                    
                    const current = await getNodeleteStatus(number, targetChat);
                    
                    if (!val || !['on', 'off'].includes(val)) {
                        return reply(`🗑️ *NODELETE STATUS*

📊 *Current:* ${current === 'on' ? '✅ ON' : '❌ OFF'}
📍 *Chat:* This ${sender.endsWith('@g.us') ? 'Group' : 'Inbox'} only
🤖 *Bot:* ${number}

*Usage:*
• \`.nodelet on\` - Auto resend deleted msgs
• \`.nodelet off\` - Disable

💡 When ON, any message deleted in this chat will be auto-resent by the bot!` + FOOTER);
                    }
                    
                    await setNodeleteStatus(number, targetChat, val);
                    
                    await reply(`✅ *NODELETE ${val === 'on' ? 'ENABLED' : 'DISABLED'}*

📊 *Status:* ${val === 'on' ? '✅ ON' : '❌ OFF'}
📍 *Chat:* This ${sender.endsWith('@g.us') ? 'Group' : 'Inbox'} only
🤖 *Bot:* ${number}

💡 ${val === 'on' ? 'Deleted messages will be auto-resent!' : 'Auto-resend disabled.'}` + FOOTER);
                    break;
                }

                // Delete recover
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
                        await reply('❌ No recent deleted message found!' + FOOTER);
                        return;
                    }

                    const senderJid = lastDeleted.sender;
                    const senderName = senderJid.split('@')[0];
                    const minsAgo = Math.floor((Date.now() - lastDeleted.timestamp) / 60000);

                    const recoverText = `╭─⏖ *🗑️ DELETED MESSAGE RECOVERED* ⏖─╮
│
│ 👤 *Sender:* @${senderName}
│ ⏰ *Time:* ${lastDeleted.time}
│ ⌛ *Deleted:* ${minsAgo}m ago
│ 💬 *Message:*
│ ${lastDeleted.text}
│
╰──────────────────────⏖` + FOOTER;

                    await reply({
                        text: recoverText.trim(),
                        mentions: [senderJid]
                    });
                    break;
                }

                // ==========================================
                // .forward
                // ==========================================
                case 'forward':
                case 'fwd': {
                    const targetJid = args[0];
                    
                    if (!targetJid) {
                        return reply(`📤 *FORWARD COMMAND*

*Usage:* \`.forward [JID]\` (reply to a message)

*Examples:*
• \`.forward 120363362308230584@newsletter\`
• \`.forward 94784280074@s.whatsapp.net\`
• \`.forward 123456789-123456@g.us\`

💡 Reply to any message (text/media) with this command!` + FOOTER);
                    }
                    
                    let normalizedJid = targetJid.trim();
                    
                    if (/^[0-9]+$/.test(normalizedJid)) {
                        normalizedJid = `${normalizedJid}@s.whatsapp.net`;
                    }
                    
                    if (/^[0-9-]+$/.test(normalizedJid)) {
                        normalizedJid = `${normalizedJid}@g.us`;
                    }
                    
                    const quoted = msg.message?.extendedTextMessage?.contextInfo;
                    if (!quoted || !quoted.quotedMessage) {
                        return reply(`⚠️ *Please reply to a message to forward!*` + FOOTER);
                    }
                    
                    try {
                        await reply(`📤 Forwarding to \`${normalizedJid}\`... ⏳` + FOOTER);
                        
                        const qMsg = unwrapMessage(quoted.quotedMessage);
                        const mediaInfo = getMediaType(qMsg);
                        
                        if (!mediaInfo) {
                            let textContent = '';
                            if (qMsg.conversation) textContent = qMsg.conversation;
                            else if (qMsg.extendedTextMessage?.text) textContent = qMsg.extendedTextMessage.text;
                            
                            if (!textContent) {
                                return reply(`❌ Could not read quoted message!` + FOOTER);
                            }
                            
                            await socket.sendMessage(normalizedJid, {
                                text: `📤 *FORWARDED MESSAGE*\n\n${textContent}` + FOOTER,
                                contextInfo: getChannelContext()
                            });
                            
                            return reply(`✅ *Message forwarded!*

📤 *To:* \`${normalizedJid}\`
💬 *Type:* Text` + FOOTER);
                        }
                        
                        const { type: messageType, data: mediaData } = mediaInfo;
                        
                        const downloadMsg = {
                            key: { 
                                remoteJid: quoted.remoteJid || sender, 
                                id: quoted.stanzaId, 
                                participant: quoted.participant 
                            },
                            message: { [messageType]: mediaData }
                        };
                        
                        const buffer = await downloadMediaMessage(
                            downloadMsg, 
                            'buffer', 
                            {}, 
                            { logger: pino({ level: 'silent' }) }
                        );
                        
                        if (!buffer || buffer.length === 0) {
                            return reply(`❌ Failed to download media!` + FOOTER);
                        }
                        
                        const caption = (mediaData?.caption || '') + `\n\n📤 _Forwarded_` + FOOTER;
                        
                        if (messageType === 'imageMessage') {
                            await socket.sendMessage(normalizedJid, {
                                image: buffer,
                                caption: caption,
                                contextInfo: getChannelContext()
                            });
                        } else if (messageType === 'videoMessage') {
                            await socket.sendMessage(normalizedJid, {
                                video: buffer,
                                caption: caption,
                                contextInfo: getChannelContext()
                            });
                        } else if (messageType === 'audioMessage') {
                            await socket.sendMessage(normalizedJid, {
                                audio: buffer,
                                mimetype: mediaData?.mimetype || 'audio/mpeg',
                                ptt: mediaData?.ptt || false,
                                contextInfo: getChannelContext()
                            });
                        } else if (messageType === 'documentMessage') {
                            await socket.sendMessage(normalizedJid, {
                                document: buffer,
                                mimetype: mediaData?.mimetype,
                                fileName: mediaData?.fileName || 'file',
                                caption: caption,
                                contextInfo: getChannelContext()
                            });
                        } else if (messageType === 'stickerMessage') {
                            await socket.sendMessage(normalizedJid, {
                                sticker: buffer,
                                contextInfo: getChannelContext()
                            });
                        } else {
                            return reply(`❌ Unsupported media type: ${messageType}` + FOOTER);
                        }
                        
                        await reply(`✅ *Message forwarded!*

📤 *To:* \`${normalizedJid}\`
💬 *Type:* ${messageType.replace('Message', '')}` + FOOTER);
                        
                    } catch (e) {
                        console.error('[FORWARD] Error:', e);
                        await reply(`❌ *Forward failed!*

📝 *Error:* ${e.message}

💡 Make sure:
• Bot is a member of target group/channel
• JID is correct
• Bot has permission to send` + FOOTER);
                    }
                    break;
                }

                // JID
                case 'jid': {
                    const chatJid = msg.key.remoteJid;
                    const senderJid = msg.key.participant || msg.key.remoteJid;
                    const quotedJid = msg.message?.extendedTextMessage?.contextInfo?.participant || 'None';

                    await reply(`📍 *JID INFORMATION*

💬 *Chat JID:* \`${chatJid}\`
👤 *Sender JID:* \`${senderJid}\`
💭 *Quoted JID:* \`${quotedJid}\`` + FOOTER);
                    break;
                }

                // AI
                case 'ai':
                case 'gpt': {
                    const query = args.join(' ');
                    if (!query) return reply(`⚠️ Please provide a question!` + FOOTER);

                    await reply(`🤖 Thinking... 🤔` + FOOTER);
                    
                    const aiAnswer = await askAI(query);

                    if (!aiAnswer) {
                        return reply(`❌ AI failed. Please try again later.` + FOOTER);
                    }

                    await reply(`🤖 *AI ASSISTANT*\n\n${aiAnswer.trim()}` + FOOTER);
                    break;
                }

                // .imagine
                case 'imagine':
                case 'aiimage': {
                    const prompt = args.join(' ');
                    if (!prompt) return reply(`⚠️ Usage: .imagine [description]` + FOOTER);

                    await reply(`🎨 Generating image... please wait ⏳` + FOOTER);
                    
                    const imageUrl = await generateAIImage(prompt);

                    if (!imageUrl) {
                        return reply(`❌ Image generation failed! Try again later.` + FOOTER);
                    }

                    try {
                        await socket.sendMessage(sender, {
                            image: { url: imageUrl },
                            caption: `🎨 *AI Generated Image*\n\n📝 Prompt: ${prompt}` + FOOTER,
                            contextInfo: channelInfo
                        }, { quoted: msg });
                    } catch (e) {
                        await reply(`❌ Failed to send image: ${e.message}` + FOOTER);
                    }
                    break;
                }

                // SONG
                case 'song': {
                    const query = args.join(' ');
                    if (!query) return reply(`⚠️ Please provide a song name!` + FOOTER);

                    await reply(`🔍 Searching for *${query}*... 🎶` + FOOTER);
                    
                    try {
                        const search = await yts(query);
                        const video = search.videos[0];
                        if (!video) return reply(`❌ Song not found!` + FOOTER);

                        pendingQualitySelection.set(sender, {
                            type: 'song',
                            url: video.url,
                            title: video.title,
                            timestamp: Date.now()
                        });

                        await socket.sendMessage(sender, {
                            image: { url: video.thumbnail },
                            caption: `🎵 *SONG FOUND!*

📝 *Title:* ${video.title}
⏱️ *Duration:* ${video.timestamp}
👁️ *Views:* ${video.views?.toLocaleString() || 'N/A'}
📅 *Uploaded:* ${video.ago}

*Reply with a number to select:*
1️⃣ - 🎵 Audio (MP3)
2️⃣ - 🎬 Video (MP4)

💡 _Reply within 2 minutes_` + FOOTER,
                            contextInfo: channelInfo
                        }, { quoted: msg });

                    } catch (e) {
                        await reply(`❌ Failed: ${e.message}` + FOOTER);
                    }
                    break;
                }

                // TIKTOK
                case 'tt':
                case 'tiktok': {
                    const url = args[0];
                    if (!url || !url.includes('tiktok.com')) {
                        return reply(`⚠️ Please provide a TikTok link!` + FOOTER);
                    }

                    await reply(`📥 Processing TikTok... ⏳` + FOOTER);
                    
                    try {
                        const mediaData = await downloadTikTok(url);

                        if (!mediaData) {
                            return reply(`❌ TikTok download failed. Try again later.` + FOOTER);
                        }

                        const isBuffer = Buffer.isBuffer(mediaData);
                        await socket.sendMessage(sender, {
                            video: isBuffer ? mediaData : { url: mediaData.url },
                            caption: `🎬 *TikTok Video*` + FOOTER,
                            contextInfo: channelInfo
                        }, { quoted: msg });

                    } catch (e) {
                        await reply(`❌ Error: ${e.message}` + FOOTER);
                    }
                    break;
                }

                // YOUTUBE
                case 'yt':
                case 'youtube': {
                    const url = args[0];

                    if (!url || (!url.includes('youtube.com') && !url.includes('youtu.be'))) {
                        return reply(`⚠️ Usage: .yt [URL]\nExample: .yt https://youtu.be/xxxx` + FOOTER);
                    }

                    try {
                        const videoId = url.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/)?.[1];
                        let videoInfo = null;
                        
                        if (videoId) {
                            videoInfo = await yts({ videoId });
                        }
                        
                        pendingQualitySelection.set(sender, {
                            type: 'youtube',
                            url: url,
                            title: videoInfo?.title || 'YouTube Video',
                            timestamp: Date.now()
                        });

                        const title = videoInfo?.title || 'YouTube Video';
                        const duration = videoInfo?.timestamp || 'N/A';
                        const thumbnail = videoInfo?.thumbnail || null;

                        const caption = `🎬 *YOUTUBE VIDEO FOUND!*

📝 *Title:* ${title}
⏱️ *Duration:* ${duration}

*Reply with a number to select:*
1️⃣ - 🎬 Video (MP4)
2️⃣ - 🎵 Audio (MP3)

💡 _Reply within 2 minutes_` + FOOTER;

                        if (thumbnail) {
                            await socket.sendMessage(sender, {
                                image: { url: thumbnail },
                                caption: caption,
                                contextInfo: channelInfo
                            }, { quoted: msg });
                        } else {
                            await reply(caption);
                        }

                    } catch (e) {
                        await reply(`❌ Failed: ${e.message}` + FOOTER);
                    }
                    break;
                }

                // FACEBOOK
                case 'fb':
                case 'facebook': {
                    const url = args[0];
                    if (!url || (!url.includes('facebook.com') && !url.includes('fb.watch') && !url.includes('fb.me'))) {
                        return reply(`⚠️ Please provide a Facebook link!` + FOOTER);
                    }

                    await reply(`📥 Processing Facebook... ⏳` + FOOTER);
                    
                    try {
                        const mediaData = await downloadFacebook(url);

                        if (!mediaData) return reply(`❌ Facebook download failed. Try again later.` + FOOTER);

                        const isBuffer = Buffer.isBuffer(mediaData);
                        await socket.sendMessage(sender, {
                            video: isBuffer ? mediaData : { url: mediaData.url },
                            caption: `🎬 *Facebook Video*` + FOOTER,
                            contextInfo: channelInfo
                        }, { quoted: msg });

                    } catch (e) {
                        await reply(`❌ Error: ${e.message}` + FOOTER);
                    }
                    break;
                }

                // INSTAGRAM
                case 'ig':
                case 'instagram': {
                    const url = args[0];
                    if (!url || !url.includes('instagram.com')) {
                        return reply(`⚠️ Please provide an Instagram link!` + FOOTER);
                    }

                    await reply(`📥 Downloading Instagram... ⏳` + FOOTER);
                    
                    try {
                        const mediaData = await downloadInstagram(url);
                        
                        if (mediaData && mediaData.length > 0) {
                            for (const media of mediaData) {
                                const mediaUrl = media.url || media.download_url || media.src;
                                const isVideo = media.type === 'video' || (mediaUrl && (mediaUrl.includes('.mp4') || media.type === 'video'));
                                
                                if (isVideo) {
                                    await socket.sendMessage(sender, {
                                        video: { url: mediaUrl },
                                        caption: `📸 *Instagram Video*` + FOOTER,
                                        contextInfo: channelInfo
                                    }, { quoted: msg });
                                } else {
                                    await socket.sendMessage(sender, {
                                        image: { url: mediaUrl },
                                        caption: `📸 *Instagram Image*` + FOOTER,
                                        contextInfo: channelInfo
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

                // MOVIE
                case 'movie':
                case 'film': {
                    const query = args.join(' ');
                    if (!query) return reply(`⚠️ Usage: .movie [movie name]` + FOOTER);

                    await reply(`🎬 Searching for *${query}*... ⏳` + FOOTER);
                    
                    try {
                        const results = await searchMovie(query);
                        
                        if (!results || !Array.isArray(results) || results.length === 0) {
                            return reply(`❌ Movie not found! Try different name.` + FOOTER);
                        }

                        let movieList = `🎬 *MOVIE SEARCH RESULTS*\n\n`;
                        const topResults = results.slice(0, 5);
                        
                        for (let i = 0; i < topResults.length; i++) {
                            const movie = topResults[i];
                            movieList += `${i+1}. *${movie.title || movie.name}*\n`;
                            movieList += `   📅 ${movie.year || movie.release_date || 'N/A'}\n`;
                            if (movie.quality) movieList += `   🎞️ ${movie.quality}\n`;
                            movieList += `\n`;
                        }
                        
                        movieList += `*Reply with a number to download*\n💡 _Reply within 2 minutes_`;

                        pendingQualitySelection.set(sender, {
                            type: 'movie_select',
                            results: topResults,
                            timestamp: Date.now()
                        });

                        await reply(movieList + FOOTER);
                        
                    } catch (e) {
                        await reply(`❌ Movie search failed: ${e.message}` + FOOTER);
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
                            return reply(`⚠️ Reply to image/video with .tourl` + FOOTER);
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
                        textToTranslate = quoted.quotedMessage.conversation || quoted.quotedMessage.extendedTextMessage?.text || '';
                    } else {
                        textToTranslate = args.slice(1).join(' ');
                    }
                    
                    if (!textToTranslate) {
                        return reply(`⚠️ Usage: .tr [lang] [text]` + FOOTER);
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

                // STICKER
                case 'sticker':
                case 's': {
                    try {
                        const quoted = msg.message?.extendedTextMessage?.contextInfo;
                        if (!quoted?.quotedMessage) {
                            return reply(`⚠️ Reply to image/video with .sticker` + FOOTER);
                        }
                        
                        let qMsg = unwrapMessage(quoted.quotedMessage);
                        
                        if (!qMsg) {
                            return reply(`⚠️ Could not read quoted message!` + FOOTER);
                        }
                        
                        const mediaInfo = getMediaType(qMsg);
                        
                        if (!mediaInfo) {
                            return reply(`⚠️ Reply to image/video only!` + FOOTER);
                        }
                        
                        const { type: messageType, data: mediaData } = mediaInfo;
                        
                        if (messageType === 'stickerMessage') {
                            const downloadMsg = {
                                key: { 
                                    remoteJid: quoted.remoteJid || sender, 
                                    id: quoted.stanzaId, 
                                    participant: quoted.participant 
                                },
                                message: { stickerMessage: mediaData }
                            };
                            
                            const buffer = await downloadMediaMessage(
                                downloadMsg, 
                                'buffer', 
                                {}, 
                                { logger: pino({ level: 'silent' }) }
                            );
                            
                            await socket.sendMessage(sender, {
                                sticker: buffer
                            }, { quoted: msg });
                            
                            return;
                        }
                        
                        const isVideo = messageType === 'videoMessage';
                        
                        await reply(`⏳ Creating sticker...` + FOOTER);
                        
                        const downloadMsg = {
                            key: { 
                                remoteJid: quoted.remoteJid || sender, 
                                id: quoted.stanzaId, 
                                participant: quoted.participant 
                            },
                            message: { [messageType]: mediaData }
                        };
                        
                        const buffer = await downloadMediaMessage(
                            downloadMsg, 
                            'buffer', 
                            {}, 
                            { logger: pino({ level: 'silent' }) }
                        );
                        
                        if (!buffer || buffer.length === 0) {
                            return reply(`❌ Failed to download media!` + FOOTER);
                        }
                        
                        const stickerBuffer = await convertToSticker(buffer, isVideo);
                        
                        if (!stickerBuffer || stickerBuffer.length === 0) {
                            return reply(`❌ Sticker conversion failed!` + FOOTER);
                        }
                        
                        await socket.sendMessage(sender, {
                            sticker: stickerBuffer,
                            mimetype: 'image/webp'
                        }, { quoted: msg });
                        
                        console.log(`[STICKER] ✅ Sent (${isVideo ? 'video' : 'image'}) - ${stickerBuffer.length} bytes`);
                        
                    } catch (e) {
                        console.error('[STICKER] Error:', e);
                        await reply(`❌ Sticker failed: ${e.message}` + FOOTER);
                    }
                    break;
                }

                // QR Code
                case 'qr':
                case 'qrcode': {
                    const text = args.join(' ');
                    if (!text) return reply(`⚠️ Usage: .qr [text]` + FOOTER);
                    
                    try {
                        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(text)}`;
                        
                        await socket.sendMessage(sender, {
                            image: { url: qrUrl },
                            caption: `📱 *QR Code*\n\n📝 Content: ${text}` + FOOTER,
                            contextInfo: channelInfo
                        }, { quoted: msg });
                    } catch (e) {
                        await reply(`❌ QR failed!` + FOOTER);
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
                        
                        await reply(`🌍 *WEATHER REPORT*

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
                            caption: `📸 *Screenshot*` + FOOTER,
                            contextInfo: channelInfo
                        }, { quoted: msg });
                    } catch (e) {
                        try {
                            const fallbackUrl = `https://image.thum.io/get/width/1200/${url}`;
                            await socket.sendMessage(sender, {
                                image: { url: fallbackUrl },
                                caption: `📸 *Screenshot*` + FOOTER,
                                contextInfo: channelInfo
                            }, { quoted: msg });
                        } catch (e2) {
                            await reply(`❌ Screenshot failed!` + FOOTER);
                        }
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
                                caption: infoText,
                                contextInfo: channelInfo
                            }, { quoted: msg });
                        } else {
                            await reply(infoText);
                        }
                    } catch (e) {
                        await reply(`❌ Info failed: ${e.message}` + FOOTER);
                    }
                    break;
                }

                // FakeChat
                case 'fakechat': {
                    const text = args.join(' ');
                    if (!text || !text.includes('|')) {
                        return reply(`⚠️ Usage: .fakechat Name|Message` + FOOTER);
                    }
                    
                    const [name, ...msgParts] = text.split('|');
                    const message = msgParts.join('|');
                    
                    await reply(`📱 Generating fake chat... ⏳` + FOOTER);
                    
                    const imageBuffer = await generateFakeChat(name, message);
                    
                    if (!imageBuffer) {
                        return reply(`❌ Fake chat failed! Try again.` + FOOTER);
                    }
                    
                    try {
                        await socket.sendMessage(sender, {
                            image: imageBuffer,
                            caption: `📱 *Fake Chat Generated*` + FOOTER,
                            contextInfo: channelInfo
                        }, { quoted: msg });
                    } catch (e) {
                        await reply(`❌ Failed to send: ${e.message}` + FOOTER);
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
                            mentions: mentions,
                            contextInfo: channelInfo
                        }, { quoted: msg });
                    } catch (e) {
                        await reply(`❌ Failed: ${e.message}` + FOOTER);
                    }
                    break;
                }

                // GETCONTACT
                case 'getcontact':
                case 'gc': {
                    if (!isOwnerUser) return reply(`⚠️ Only Bot Owner!` + FOOTER);
                    if (!sender.endsWith('@g.us')) return reply(`⚠️ Group only!` + FOOTER);
                    
                    const lockKey = number;
                    const existingLock = getContactLocks.get(lockKey);
                    if (existingLock?.running) {
                        return reply(`⏳ *GetContact already running!*

📊 *Progress:* ${existingLock.sent} sent
⏱️ *Started:* ${Math.floor((Date.now() - existingLock.startTime) / 1000)}s ago

💡 Please wait for it to finish!` + FOOTER);
                    }
                    
                    try {
                        const meta = await socket.groupMetadata(sender);
                        const botJid = socket.user.id.split(':')[0] + '@s.whatsapp.net';
                        
                        const members = meta.participants
                            .filter(p => p.id !== botJid && p.id !== msg.key.participant)
                            .map(p => p.id);
                        
                        if (members.length === 0) {
                            return reply(`❌ No members to message!` + FOOTER);
                        }
                        
                        const MAX_SAFE = 50;
                        const targetMembers = members.slice(0, MAX_SAFE);
                        const skipped = members.length - targetMembers.length;
                        
                        const estTime = Math.ceil(targetMembers.length * 10 / 60);
                        
                        await reply(`📱 *STARTING GETCONTACT (SAFE MODE)*

📊 *Members Found:* ${members.length}
🎯 *Will Message:* ${targetMembers.length}
${skipped > 0 ? `⚠️ *Skipped (safe limit):* ${skipped}\n` : ''}⏱️ *Est. Time:* ~${estTime} min
🛡️ *Ban Protection:* ENABLED

💡 *Safety Features:*
• Random 10-15s delays
• 60s break every 5 msgs
• Max ${MAX_SAFE} messages per run
• Rate limit detection

⚠️ *Do NOT run other bulk commands!*` + FOOTER);
                        
                        getContactLocks.set(lockKey, {
                            running: true,
                            sent: 0,
                            startTime: Date.now()
                        });
                        
                        const messages = [
                            'Hi 👋',
                            'Hello 👋',
                            'Mk 😊',
                            'Hey there!',
                            'Good day!',
                            'Hi! How are you?'
                        ];
                        
                        let sent = 0;
                        let failed = 0;
                        let rateLimited = false;
                        
                        for (let i = 0; i < targetMembers.length; i++) {
                            const memberJid = targetMembers[i];
                            if (memberJid === botJid) continue;
                            
                            if (rateLimited) {
                                console.log(`[GETCONTACT] ⛔ Stopped early due to rate limit`);
                                break;
                            }
                            
                            try {
                                const randomMsg = messages[Math.floor(Math.random() * messages.length)];
                                
                                await sendWithTyping(socket, memberJid, {
                                    text: randomMsg + FOOTER,
                                    contextInfo: getChannelContext()
                                });
                                
                                sent++;
                                const lock = getContactLocks.get(lockKey);
                                if (lock) lock.sent = sent;
                                
                                console.log(`[GETCONTACT] ✅ ${sent}/${targetMembers.length} - ${memberJid}`);
                                
                                const randomDelay = Math.floor(Math.random() * 5000) + 10000;
                                await delay(randomDelay);
                                
                                if (sent % 5 === 0 && sent < targetMembers.length) {
                                    console.log(`[GETCONTACT] ☕ Taking 60s break after ${sent} messages`);
                                    await delay(60000);
                                }
                                
                            } catch (err) {
                                failed++;
                                const errMsg = (err.message || '').toLowerCase();
                                console.log(`[GETCONTACT] ❌ Failed ${memberJid}: ${err.message}`);
                                
                                if (errMsg.includes('rate') || 
                                    errMsg.includes('limit') ||
                                    errMsg.includes('too many') ||
                                    errMsg.includes('spam') ||
                                    errMsg.includes('block')) {
                                    
                                    console.log('[GETCONTACT] 🚨 RATE LIMIT DETECTED! Stopping...');
                                    rateLimited = true;
                                    break;
                                }
                                
                                await delay(15000);
                            }
                        }
                        
                        getContactLocks.delete(lockKey);
                        
                        const finalMsg = rateLimited 
                            ? `⚠️ *GETCONTACT STOPPED (Rate Limit)*

📊 *Results:*
✅ *Sent:* ${sent}
❌ *Failed:* ${failed}
📱 *Total:* ${targetMembers.length}

🚨 *WhatsApp rate limit detected!*
💡 *Wait 24 hours before trying again!*`
                            : `✅ *GETCONTACT COMPLETE!*

📊 *Results:*
✅ *Sent:* ${sent}
❌ *Failed:* ${failed}
📱 *Total:* ${targetMembers.length}
${skipped > 0 ? `⏭️ *Skipped:* ${skipped}\n` : ''}
💡 *Note:* Some users may not receive messages due to privacy settings.`;
                        
                        await reply(finalMsg + FOOTER);
                        
                    } catch (e) {
                        getContactLocks.delete(lockKey);
                        console.error('[GETCONTACT] Error:', e);
                        await reply(`❌ Failed: ${e.message}` + FOOTER);
                    }
                    break;
                }

                // KICK
                case 'kick': {
                    if (!sender.endsWith('@g.us')) return reply(`⚠️ Group only!` + FOOTER);
                    const quoted = msg.message?.extendedTextMessage?.contextInfo;
                    if (!quoted?.participant) return reply(`⚠️ Reply to a user!` + FOOTER);
                    
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
                    if (!quoted?.participant) return reply(`⚠️ Reply to a user!` + FOOTER);
                    
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
                    if (!quoted?.participant) return reply(`⚠️ Reply to a user!` + FOOTER);
                    
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
👑 *Members:* ${meta.participants.length}
👑 *Admins:* ${admins.length}
📅 *Created:* ${new Date(meta.creation * 1000).toLocaleDateString()}
📝 *Desc:* ${meta.desc || 'No description'}` + FOOTER;
                        
                        if (ppUrl) {
                            await socket.sendMessage(sender, {
                                image: { url: ppUrl },
                                caption: infoText,
                                contextInfo: channelInfo
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
                        "මිනිහෙක් දුවලා ගිහින් කිව්වලු 'ඔයාට බත් දෙන්න' කියලා. ගිහින් කිව්වා 'කොහොමද මේ?' මිනිහා කිව්වා 'වහලේ ගහන්න' කියලා 😂",
                        "ගුරුවරයා: 'ඔය මොකද මේ පන්තියේ නිදාගන්නේ?' ළමයා: 'සර් මම සිහිනෙන් ඉගෙන ගන්නවා' 😅",
                        "එක මිනිහෙක් දොස්තරට කිව්වා 'මට කන්න බෑ' කියලා. දොස්තර කිව්වා 'මොකද?' මිනිහා කිව්වා 'කට ඇරියම කෑම එලියට වැටෙනවා' 🤣"
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

                // IP
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

                // TTS
                case 'tts':
                case 'say': {
                    const text = args.join(' ');
                    if (!text) return reply(`⚠️ Usage: .tts [text]` + FOOTER);
                    
                    try {
                        await reply(`🎤 Generating voice... ⏳` + FOOTER);
                        
                        const maxLen = 180;
                        const textChunks = [];
                        if (text.length > maxLen) {
                            const words = text.split(' ');
                            let currentChunk = '';
                            for (const word of words) {
                                if ((currentChunk + ' ' + word).trim().length > maxLen) {
                                    textChunks.push(currentChunk.trim());
                                    currentChunk = word;
                                } else {
                                    currentChunk = (currentChunk + ' ' + word).trim();
                                }
                            }
                            if (currentChunk) textChunks.push(currentChunk.trim());
                        } else {
                            textChunks.push(text);
                        }
                        
                        for (const chunk of textChunks) {
                            const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(chunk)}&tl=en&client=tw-ob&total=${textChunks.length}&idx=${textChunks.indexOf(chunk)}&textlen=${chunk.length}`;
                            
                            const response = await axios.get(ttsUrl, { 
                                responseType: 'arraybuffer', 
                                timeout: 20000,
                                headers: {
                                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                                    'Referer': 'https://translate.google.com/',
                                    'Accept': 'audio/webm,audio/ogg,audio/wav,audio/*;q=0.9,*/*;q=0.5',
                                    'Accept-Language': 'en-US,en;q=0.9'
                                }
                            });
                            
                            const mp3Buffer = Buffer.from(response.data);
                            
                            if (mp3Buffer.length < 500) {
                                console.log('[TTS] Response too small, might be error');
                                continue;
                            }
                            
                            const opusBuffer = await convertTtsToOpus(mp3Buffer);
                            
                            if (!opusBuffer || opusBuffer.length < 500) {
                                console.log('[TTS] Opus conversion failed, sending MP3 instead');
                                await socket.sendMessage(sender, {
                                    audio: mp3Buffer,
                                    mimetype: 'audio/mpeg',
                                    ptt: true,
                                    contextInfo: channelInfo
                                }, { quoted: msg });
                            } else {
                                await socket.sendMessage(sender, {
                                    audio: opusBuffer,
                                    mimetype: 'audio/ogg; codecs=opus',
                                    ptt: true,
                                    contextInfo: channelInfo
                                }, { quoted: msg });
                                console.log(`[TTS] ✅ Sent voice note (${opusBuffer.length} bytes)`);
                            }
                            
                            if (textChunks.length > 1) await delay(1000);
                        }
                        
                    } catch (e) {
                        console.error('[TTS] Error:', e);
                        await reply(`❌ TTS failed: ${e.message}` + FOOTER);
                    }
                    break;
                }

                // CRYPTO
                case 'crypto':
                case 'price': {
                    let coin = args[0]?.toLowerCase();
                    if (!coin) return reply(`⚠️ Usage: .crypto [coin]\nExample: .crypto btc` + FOOTER);
                    
                    const coinMap = {
                        'btc': 'bitcoin', 'eth': 'ethereum', 'bnb': 'binancecoin',
                        'xrp': 'ripple', 'doge': 'dogecoin', 'ada': 'cardano',
                        'sol': 'solana', 'matic': 'matic-network', 'dot': 'polkadot',
                        'ltc': 'litecoin', 'trx': 'tron', 'shib': 'shiba-inu'
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
${emoji} *24h:* ${change}%` + FOOTER);
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
                                caption: info,
                                contextInfo: channelInfo
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
                            caption: `🎨 *Text Image*` + FOOTER,
                            contextInfo: channelInfo
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

                // .setreply
                case 'setreply': {
                    if (!isOwnerUser) return reply(`⚠️ Only Bot Owner!` + FOOTER);
                    
                    const trigger = args[0]?.toLowerCase();
                    const response = args.slice(1).join(' ');
                    
                    if (!trigger || !response) {
                        return reply(`⚠️ Usage: .setreply [trigger] [response]` + FOOTER);
                    }
                    
                    const state = getAutoReplyState(number);
                    state.customReplies[trigger] = response;
                    await saveAutoReplySettings(number);
                    
                    await reply(`✅ Custom reply set!

🔤 *Trigger:* ${trigger}
💬 *Response:* ${response}

💡 Use \`.autoreply list\` to see all replies!` + FOOTER);
                    break;
                }

                // DELREPLY
                case 'delreply': {
                    if (!isOwnerUser) return reply(`⚠️ Only Bot Owner!` + FOOTER);
                    
                    const trigger = args[0]?.toLowerCase();
                    if (!trigger) return reply(`⚠️ Usage: .delreply [trigger]` + FOOTER);
                    
                    const state = getAutoReplyState(number);
                    delete state.customReplies[trigger];
                    await saveAutoReplySettings(number);
                    
                    await reply(`✅ Removed: *${trigger}*` + FOOTER);
                    break;
                }

                // LISTREPLY
                case 'listreply': {
                    if (!isOwnerUser) return reply(`⚠️ Only Bot Owner!` + FOOTER);
                    
                    const state = getAutoReplyState(number);
                    const triggers = Object.keys(state.customReplies);
                    
                    if (triggers.length === 0) {
                        return reply(`📝 No custom replies!` + FOOTER);
                    }
                    
                    let list = `📝 *CUSTOM REPLIES*\n\n`;
                    triggers.forEach((t, i) => {
                        list += `${i+1}. *${t}* → ${state.customReplies[t]}\n`;
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
                        return reply(`⚠️ Usage: .remind [time] [message]` + FOOTER);
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
                                mentions: [msg.key.participant || sender],
                                contextInfo: channelInfo
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
                    
                    const sent = await socket.sendMessage(sender, { text: pollMsg, contextInfo: channelInfo });
                    
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

                // ANTI-LINK
                case 'antilink': {
                    if (!sender.endsWith('@g.us')) return reply(`⚠️ Group only!` + FOOTER);
                    
                    let isAdmin = msg.key.fromMe;
                    if (!isAdmin) {
                        try {
                            const meta = await socket.groupMetadata(sender);
                            const participant = meta.participants.find(p => p.id === msg.key.participant);
                            isAdmin = participant?.admin === 'admin' || participant?.admin === 'superadmin';
                        } catch (e) {}
                    }
                    
                    if (!isAdmin) return reply(`⚠️ Only admins!` + FOOTER);
                    
                    const val = args[0]?.toLowerCase();
                    
                    let current = groupAntiLink.get(sender);
                    if (current === undefined || current === null) {
                        let dbVal = null;
                        try { dbVal = await get(`ANTILINK_${sender}`, number); } catch (e) {}
                        if (!dbVal) {
                            try { 
                                const cleanKey = sender.replace(/[^0-9]/g, '');
                                dbVal = await get(`ANTILINK_${cleanKey}`, number); 
                            } catch (e) {}
                        }
                        current = dbVal || 'off';
                        groupAntiLink.set(sender, current);
                    }
                    
                    if (!val || !['on', 'off'].includes(val)) {
                        return reply(`🔗 *ANTI-LINK STATUS*\n\n📊 *Current:* ${current === 'on' ? '✅ ON' : '❌ OFF'}\n\n*Usage:* .antilink on/off` + FOOTER);
                    }
                    
                    groupAntiLink.set(sender, val);
                    
                    try {
                        await handleSettingUpdate(`ANTILINK_${sender}`, val, reply, number);
                    } catch (e) {
                        try {
                            const cleanKey = sender.replace(/[^0-9]/g, '');
                            await handleSettingUpdate(`ANTILINK_${cleanKey}`, val, reply, number);
                        } catch (e2) {}
                    }
                    
                    await reply(`✅ *Anti-Link ${val === 'on' ? 'ENABLED' : 'DISABLED'}*` + FOOTER);
                    break;
                }

                // WELCOME
                case 'welcome': {
                    if (!sender.endsWith('@g.us')) return reply(`⚠️ Group only!` + FOOTER);
                    
                    let isAdmin = msg.key.fromMe;
                    if (!isAdmin) {
                        try {
                            const meta = await socket.groupMetadata(sender);
                            const participant = meta.participants.find(p => p.id === msg.key.participant);
                            isAdmin = participant?.admin === 'admin' || participant?.admin === 'superadmin';
                        } catch (e) {}
                    }
                    
                    if (!isAdmin) return reply(`⚠️ Only admins!` + FOOTER);
                    
                    const val = args[0]?.toLowerCase();
                    
                    let current = groupWelcome.get(sender);
                    if (current === undefined || current === null) {
                        let dbVal = null;
                        try { dbVal = await get(`WELCOME_${sender}`, number); } catch (e) {}
                        if (!dbVal) {
                            try { 
                                const cleanKey = sender.replace(/[^0-9]/g, '');
                                dbVal = await get(`WELCOME_${cleanKey}`, number); 
                            } catch (e) {}
                        }
                        current = dbVal || 'off';
                        groupWelcome.set(sender, current);
                    }
                    
                    if (!val || !['on', 'off'].includes(val)) {
                        return reply(`👋 *WELCOME STATUS*\n\n📊 *Current:* ${current === 'on' ? '✅ ON' : '❌ OFF'}\n\n*Usage:* .welcome on/off` + FOOTER);
                    }
                    
                    groupWelcome.set(sender, val);
                    
                    try {
                        await handleSettingUpdate(`WELCOME_${sender}`, val, reply, number);
                    } catch (e) {
                        try {
                            const cleanKey = sender.replace(/[^0-9]/g, '');
                            await handleSettingUpdate(`WELCOME_${cleanKey}`, val, reply, number);
                        } catch (e2) {}
                    }
                    
                    await reply(`✅ *Welcome ${val === 'on' ? 'ENABLED' : 'DISABLED'}*` + FOOTER);
                    break;
                }

                // VV
                case 'vv':
                case 'viewonce': {
                    const quoted = msg.message?.extendedTextMessage?.contextInfo;
                    if (!quoted || !quoted.quotedMessage) {
                        return reply(`⚠️ Reply to View Once media with *${prefix}vv*` + FOOTER);
                    }

                    let qMsg = unwrapMessage(quoted.quotedMessage);
                    if (!qMsg) {
                        return reply(`⚠️ Could not read quoted message!` + FOOTER);
                    }

                    const mediaInfo = getMediaType(qMsg);
                    if (!mediaInfo || !['imageMessage', 'videoMessage'].includes(mediaInfo.type)) {
                        return reply(`⚠️ Reply to View Once media!` + FOOTER);
                    }

                    const { type: messageType, data: mediaData } = mediaInfo;
                    const downloadMsg = {
                        key: { remoteJid: quoted.remoteJid || sender, id: quoted.stanzaId, participant: quoted.participant },
                        message: { [messageType]: mediaData }
                    };

                    try {
                        const buffer = await downloadMediaMessage(downloadMsg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                        const caption = `📥 *View Once Media*\n\n${mediaData?.caption || ''}` + FOOTER;

                        if (messageType === 'imageMessage') {
                            await socket.sendMessage(sender, { image: buffer, caption, contextInfo: channelInfo }, { quoted: msg });
                        } else if (messageType === 'videoMessage') {
                            await socket.sendMessage(sender, { video: buffer, caption, contextInfo: channelInfo }, { quoted: msg });
                        }
                    } catch (err) {
                        await reply(`❌ Failed: ${err.message}` + FOOTER);
                    }
                    break;
                }

                // MENU
                case 'allmenu':
                case 'menu':
                case 'help': {
                    const isFollowing = await checkChannelFollow(socket, msg.key.participant || sender);
                    const followStatus = isFollowing ? '✅ Followed' : '❌ Not Followed';

                    const captionText = `
*👋 ${botName.toUpperCase()} 🧃🇱🇰*
*-- The Mini Whatsapp Bot Experience --*

> © ᴄʀᴇᴀᴛᴏʀ ʙY ɴɪᴍꜱᴀʀᴀ 🥷🏻
> 🪀 Contact - 0784280074

─────────────────────
*BOT STATUS 👾*
> Bot Name : ${botName}
> Activers : ${activeSockets.size}
> Channel : ${followStatus}
> Bot Creator : NIMSARA
─────────────────────

*╭─\`🎈 𝗠𝗔𝗜𝗡 𝗠𝗘𝗡𝗨 𝗖𝗔𝗧𝗘𝗚𝗢𝗥𝗜𝗘𝗦\`┤⭓*
*┃*
*┃ 1️⃣ - 📥 DOWNLOAD COMMANDS*
*┃ 2️⃣ - ⚙️ SETTINGS COMMANDS*
*┃ 3️⃣ - 👑 OWNER COMMANDS*
*┃ 4️⃣ - 🛠️ UTILITY COMMANDS*
*┃ 5️⃣ - 🤖 AI & CONVERT*
*┃ 6️⃣ - 👑 GROUP ADMIN*
*┃ 7️⃣ - 🎮 FUN COMMANDS*
*┃*
*╰──────────────────────*

💡 *Reply to this message with a number!*

> 🔗 Web: https://nimsara-official.vercel.app/

> *📢 FOLLOW CHANNEL :- ${BOT_CHANNEL_LINK}*

> _© ᴄʀᴇᴀᴛᴏʀ ʙY ɴɪᴍꜱᴀʀᴀ 🥷🏻_`;

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
                            ptt: false,
                            contextInfo: channelInfo
                        }, { quoted: msg });
                    }
                    break;
                }

                // .mode
                case 'mode': {
                    if (!isOwnerUser) return reply(`⚠️ Only Bot Owner!` + FOOTER);
                    const option = args[0] ? args[0].toLowerCase() : '';
                    const validModes = ['public', 'group', 'inbox', 'private'];
                    if (!validModes.includes(option)) {
                        const currentMode = await get('BOT_MODE', number) || 'public';
                        return reply(`⚙️ *Bot Mode*\n\nCurrent: *${currentMode.toUpperCase()}*\n\nOptions:\n• .mode public\n• .mode group\n• .mode inbox\n• .mode private` + FOOTER);
                    }
                    await handleSettingUpdate("BOT_MODE", option, reply, number);
                    break;
                }

                case 'ping': {
                    const start = Date.now();
                    const sentMsg = await socket.sendMessage(sender, { text: 'Pinging...' }, { quoted: msg });
                    const latency = Date.now() - start;
                    await socket.sendMessage(sender, { text: `🏓 Pong! *${latency}ms*` + FOOTER }, { quoted: sentMsg });
                    break;
                }

                // .autoread
                case 'autoread': {
                    if (!isOwnerUser) return reply(`⚠️ Only Bot Owner!` + FOOTER);
                    const option = args[0] ? args[0].toLowerCase() : '';
                    const validOptions = ['all', 'cmd', 'off'];
                    if (!validOptions.includes(option)) {
                        return reply(`👁️ *Auto-Read*\n\nCurrent: *${(global.autoReadStatus || 'off').toUpperCase()}*\n\nOptions:\n• .autoread all\n• .autoread cmd\n• .autoread off` + FOOTER);
                    }
                    global.autoReadStatus = option;
                    await reply(`✅ Auto-Read: *${global.autoReadStatus.toUpperCase()}*` + FOOTER);
                    break;
                }

                // .autoreply
                case 'autoreply': {
                    if (!isOwnerUser) return reply(`⚠️ Only Bot Owner!` + FOOTER);
                    
                    const option = args[0] ? args[0].toLowerCase() : '';
                    const state = getAutoReplyState(number);
                    const validOptions = ['all', 'inbox', 'group', 'off', 'list'];
                    
                    if (option === 'list') {
                        const triggers = Object.keys(state.customReplies);
                        
                        let listMsg = `🤖 *AUTO-REPLY SETTINGS*

📊 *Mode:* ${state.mode.toUpperCase()}
🔤 *Custom Replies:* ${triggers.length}

`;
                        
                        if (triggers.length === 0) {
                            listMsg += `📝 _No custom replies yet_\n\n`;
                            listMsg += `💡 *Add one with:*\n.setreply [trigger] [response]`;
                        } else {
                            listMsg += `*📝 Custom Reply List:*\n\n`;
                            triggers.forEach((t, i) => {
                                const preview = state.customReplies[t].length > 30 
                                    ? state.customReplies[t].substring(0, 30) + '...' 
                                    : state.customReplies[t];
                                listMsg += `${i+1}. *${t}*\n   ↳ ${preview}\n\n`;
                            });
                            listMsg += `💡 Use \`.delreply [trigger]\` to remove`;
                        }
                        
                        return reply(listMsg + FOOTER);
                    }
                    
                    if (!validOptions.includes(option)) {
                        return reply(`🤖 *Auto-Reply*

📊 *Current:* ${state.mode.toUpperCase()}
🔤 *Custom Replies:* ${Object.keys(state.customReplies).length}

*Options:*
• .autoreply all
• .autoreply inbox
• .autoreply group
• .autoreply off
• .autoreply list - View all replies

🛡️ *Loop Protection: ENABLED*
🤖 *Bot Filter: ENABLED*
🔒 *Per-Session: YES*` + FOOTER);
                    }
                    
                    state.mode = option;
                    await saveAutoReplySettings(number);
                    
                    await reply(`✅ Auto-Reply: *${state.mode.toUpperCase()}*

🔒 This setting applies ONLY to bot +${number}
🤖 Bot messages will be ignored

💡 Use \`.autoreply list\` to see custom replies` + FOOTER);
                    break;
                }

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
                        caption: aliveText,
                        contextInfo: channelInfo
                    }, { quoted: msg });

                    await delay(1500);

                    const audioBuffer2 = await getAudioBuffer(BOT_AUDIO_URL);
                    if (audioBuffer2) {
                        await socket.sendMessage(sender, {
                            audio: audioBuffer2,
                            mimetype: 'audio/mpeg',
                            ptt: false,
                            contextInfo: channelInfo
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
                    await reply(`⏱️ *${botName} Uptime:* ${hours}h ${minutes}m ${seconds}s` + FOOTER);
                    break;
                }

                case 'owner': {
                    await reply(`👑 *Bot Owner*\n> Name: Nimsara\n> Contact: 0784280074\n> Bot: ${botName}` + FOOTER);
                    break;
                }

                case 'send':
                case 'save': {
                    const quoted = msg.message?.extendedTextMessage?.contextInfo;
                    if (!quoted || !quoted.quotedMessage) {
                        return reply(`⚠️ Reply to media!` + FOOTER);
                    }
                    
                    let qMsg = unwrapMessage(quoted.quotedMessage);
                    if (!qMsg) {
                        return reply(`⚠️ Could not read quoted message!` + FOOTER);
                    }
                    
                    const mediaInfo = getMediaType(qMsg);
                    if (!mediaInfo) {
                        return reply(`⚠️ Reply to media!` + FOOTER);
                    }
                    
                    const { type: messageType, data: mediaData } = mediaInfo;
                    
                    if (!['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage'].includes(messageType)) {
                        return reply(`⚠️ Reply to image/video/audio/document!` + FOOTER);
                    }
                    
                    const downloadMsg = {
                        key: { remoteJid: quoted.remoteJid || sender, id: quoted.stanzaId, participant: quoted.participant },
                        message: { [messageType]: mediaData }
                    };
                    
                    try {
                        const buffer = await downloadMediaMessage(downloadMsg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                        const caption = `${mediaData?.caption || ''}` + FOOTER;
                        
                        if (messageType === 'imageMessage') {
                            await socket.sendMessage(sender, { image: buffer, caption, contextInfo: channelInfo }, { quoted: msg });
                        } else if (messageType === 'videoMessage') {
                            await socket.sendMessage(sender, { video: buffer, caption, contextInfo: channelInfo }, { quoted: msg });
                        } else if (messageType === 'audioMessage') {
                            await socket.sendMessage(sender, { audio: buffer, mimetype: 'audio/mpeg', ptt: mediaData?.ptt || false, contextInfo: channelInfo }, { quoted: msg });
                        } else if (messageType === 'documentMessage') {
                            await socket.sendMessage(sender, { document: buffer, mimetype: mediaData?.mimetype, fileName: mediaData?.fileName, contextInfo: channelInfo }, { quoted: msg });
                        }
                    } catch (err) {
                        await reply(`❌ Failed: ${err.message}` + FOOTER);
                    }
                    break;
                }

                // .setprefix
                case 'setprefix': {
                    if (!isOwnerUser) return reply(`⚠️ Only Bot Owner!` + FOOTER);
                    const newPrefix = args[0];
                    if (!newPrefix) return reply(`⚠️ Usage: .setprefix [New Prefix]` + FOOTER);
                    await handleSettingUpdate("PREFIX", newPrefix, reply, number);
                    break;
                }

                case 'settings': {
                    const pfx = await get('PREFIX', number) || '.';
                    const bName = await get('BOT_NAME', number) || 'NIM BOT';
                    const autoView = await get('AUTO_VIEW_STATUS', number) ?? 'true';
                    const autoLike = await get('AUTO_LIKE_STATUS', number) ?? 'true';
                    const alwaysOnline = await get('ALWAYS_ONLINE', number) ?? 'true';
                    const autoSaveStatus = await get('AUTOSAVE', number) || 'off';
                    const autoSaveName = await get('AUTOSAVE_NAME', number) || 'NIM SAVE';
                    const autoReplyState = getAutoReplyState(number);
                    const vvpEmoji = getVvpEmojis(number);
                    const statusREmoji = getStatusReactionEmoji(number);

                    await reply(`⚙️ *${bName} SETTINGS*

> Bot Owner: Nimsara
> Bot Name: *${bName}*
> Prefix: *${pfx}*
> Auto View: *${autoView}*
> Auto Like: *${autoLike}*
> Always Online: *${alwaysOnline}*
> Auto Save: *${autoSaveStatus}*
> Save Name: *${autoSaveName}*
> Auto Reply: *${autoReplyState.mode.toUpperCase()}*
> Custom Replies: *${Object.keys(autoReplyState.customReplies).length}*
> VVP Emoji: *${vvpEmoji}*
> Status Save Emoji: *${statusREmoji || 'Not set'}*

🛠️ *Commands:*
• ${pfx}autoview [on/off]
• ${pfx}autolike [on/off]
• ${pfx}alwaysonline [on/off]
• ${pfx}autosave [on/off]
• ${pfx}autoreply [mode]
• ${pfx}vvpr [emoji1,emoji2]
• ${pfx}statusr [emoji]
• ${pfx}setprefix [prefix]` + FOOTER);
                    break;
                }

                // .autoview
                case 'autoview': {
                    if (!isOwnerUser) return reply(`⚠️ Only Bot Owner!` + FOOTER);
                    const val = args[0]?.toLowerCase();
                    if (!val || !['on', 'off', 'true', 'false'].includes(val)) {
                        return reply(`⚠️ Usage: .autoview on/off` + FOOTER);
                    }
                    const normalized = (val === 'on' || val === 'true') ? 'true' : 'false';
                    await handleSettingUpdate("AUTO_VIEW_STATUS", normalized, reply, number);
                    break;
                }

                // .autolike
                case 'autolike': {
                    if (!isOwnerUser) return reply(`⚠️ Only Bot Owner!` + FOOTER);
                    const val = args[0]?.toLowerCase();
                    if (!val || !['on', 'off', 'true', 'false'].includes(val)) {
                        return reply(`⚠️ Usage: .autolike on/off` + FOOTER);
                    }
                    const normalized = (val === 'on' || val === 'true') ? 'true' : 'false';
                    await handleSettingUpdate("AUTO_LIKE_STATUS", normalized, reply, number);
                    break;
                }

                // .alwaysonline
                case 'alwaysonline': {
                    if (!isOwnerUser) return reply(`⚠️ Only Bot Owner!` + FOOTER);
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

    // Welcome/Goodbye
    socket.ev.on('group-participants.update', async (update) => {
        try {
            const { id, participants, action } = update;
            
            let welcomeEnabled = groupWelcome.get(id);
            if (!welcomeEnabled) {
                let dbVal = null;
                try { dbVal = await get(`WELCOME_${id}`, number); } catch (e) {}
                if (!dbVal) {
                    try { 
                        const cleanKey = id.replace(/[^0-9]/g, '');
                        dbVal = await get(`WELCOME_${cleanKey}`, number); 
                    } catch (e) {}
                }
                welcomeEnabled = dbVal || 'off';
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
                        mentions: [userJid],
                        contextInfo: getChannelContext()
                    });
                } else if (action === 'remove') {
                    await socket.sendMessage(id, {
                        text: `👋 *GOODBYE* @${userName}!\n\n😢 We'll miss you!` + FOOTER,
                        mentions: [userJid],
                        contextInfo: getChannelContext()
                    });
                }
            }
        } catch (e) {
            console.log("Group welcome error:", e.message);
        }
    });
}

// ==========================================
// Check Channel Follow
// ==========================================
async function checkChannelFollow(socket, userJid) {
    try {
        const channelMeta = await socket.newsletterMetadata('jid', CHANNEL_JID);
        if (!channelMeta) return false;
        if (channelMeta.viewer_metadata) {
            return channelMeta.viewer_metadata.role === 'ADMIN' || 
                   channelMeta.viewer_metadata.role === 'OWNER' ||
                   channelMeta.viewer_metadata.role === 'SUBSCRIBER';
        }
        return false;
    } catch (e) {
        return false;
    }
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
                        const emojis = ['❤️', '🔦', '👌', '✨', '🤍', '🌝'];
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
        console.log("🔍 Checking for existing sessions...");
        
        await loadGlobalOwnerList();
        
        const allSessions = await Session.find({});
        
        if (allSessions.length === 0) {
            console.log("⏹️ No existing sessions found.");
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
                    caption: `🎉 *${botName} CONNECTED* 🎉

✅ Your WhatsApp Bot is now online and active!

• Name: *${botName}*
• Number: *${botNumber}*
• Prefix: *${currentPrefix}*

Type *${currentPrefix}menu* to view commands.
බොට්ගේ මෙනු එක ගන්න *${currentPrefix}menu* කියලා ටයිප් කරලා දාන්න.

> Help - 0784280074
> 🔗 Channel: ${BOT_CHANNEL_LINK}

> © ᴄʀᴇᴀᴛᴏʀ ʙY ɴɪᴍꜱᴀʀᴀ 🥷🏻`,
                    contextInfo: getChannelContext()
                });

                await delay(1500);

                const audioBuffer = await getAudioBuffer(BOT_AUDIO_URL);
                if (audioBuffer) {
                    await currentSock.sendMessage(ownJid, {
                        audio: audioBuffer,
                        mimetype: 'audio/mpeg',
                        ptt: false,
                        contextInfo: getChannelContext()
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

                if (!GLOBAL_OWNER_LIST_LOADED) {
                    await loadGlobalOwnerList();
                }
                
                await loadAutoReplySettings(sanitizedNumber);
                await loadVvpSettings(sanitizedNumber);
                await loadStatusReactionSettings(sanitizedNumber);

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
            try { await sock.logout(); await sock.end(); } catch (e) {}
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

(async () => {
    try {
        await delay(5000);
        await restoreExistingSessions();
    } catch (e) {
        console.error("Restore error:", e.message);
    }
})();

module.exports = router;
