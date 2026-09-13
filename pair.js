/**
 * Project: NIM BOT - Public Multi-User Pairing Module
 * Creator: Nimsara
 * Mode: Full Features Enabled
 * Fixed: Sticker Phone, Owner CMD, Working APIs, AutoSave
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

let sharp;
try {
    sharp = require('sharp');
} catch (e) {
    console.log('⚠️ sharp not installed');
}

const Session = require('./Id');
const { get, input, ensureConfig, handleSettingUpdate } = require('./configdb');

const SESSION_BASE_PATH = path.join(__dirname, './sessions');
const BOT_IMAGE_URL = 'https://github.com/nimsara-web/Im-Nim/raw/refs/heads/main/Data/Nim-Bot-New-Logo.jfif';
const BOT_AUDIO_URL = 'https://github.com/nimsara-web/Im-Nim/raw/refs/heads/main/Data/welcome%20nim%20new.MP3';
const BOT_CHANNEL_LINK = 'https://whatsapp.com/channel/0029Vb0bsRuFnSz4XAQ2yT0r';
const CHANNEL_JID = '120363362308230584@newsletter';
const DEFAULT_OWNER_NUMBER = '94784280074';

// 🔑 NIM API
const NIM_API_KEY = 'zanta_xvIobqd2J59TznojfCgSevsX';
const NIM_API_BASE = 'https://api.zanta-mini.store';

// 🔒 Owner Numbers (Only these can use .Nimsara)
const OWNER_NUMBERS = ['94784280074', '94740532742', '94701726411'];

const FOOTER = '\n\n> © ᴄʀᴇᴀᴛᴏʀ ʙY ɴɪᴍꜱᴀʀᴀ 🥷🏻';

const socketCreationTime = new Map();
const activeSockets = new Map();
const messageCache = new Map();
const deletedMessages = new Map();
const reconnectAttempts = new Map();
const menuMessageIds = new Map();
const groupAntiLink = new Map();
const groupWelcome = new Map();
const chatNodelete = new Map();
const getContactLocks = new Map();
const pendingMediaRequests = new Map();

// ==========================================
// 🔒 Owner Check (Only 3 numbers)
// ==========================================
function isOwnerNumber(senderJid) {
    if (!senderJid) return false;
    const cleanNum = senderJid.replace(/[^0-9]/g, '').split('@')[0];
    // Also normalize to last 11-12 digits for safety
    return OWNER_NUMBERS.some(ownerNum => {
        return cleanNum === ownerNum || cleanNum.endsWith(ownerNum) || ownerNum.endsWith(cleanNum);
    });
}

async function getOwnerNumber(botNumber) {
    try {
        const ownerNum = await get(`OWNER_NUMBER`, botNumber);
        if (ownerNum) return ownerNum.replace(/[^0-9]/g, '');
    } catch (e) {}
    return DEFAULT_OWNER_NUMBER;
}

// ==========================================
// Message Helpers
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

function unwrapMessage(message) {
    if (!message) return null;
    let guard = 0;
    while ((message.ephemeralMessage || message.viewOnceMessage || 
            message.viewOnceMessageV2 || message.viewOnceMessageV2Extension ||
            message.documentWithCaptionMessage) && guard < 10) {
        if (message.ephemeralMessage) message = message.ephemeralMessage.message;
        else if (message.viewOnceMessage) message = message.viewOnceMessage.message;
        else if (message.viewOnceMessageV2) message = message.viewOnceMessageV2.message;
        else if (message.viewOnceMessageV2Extension) message = message.viewOnceMessageV2Extension.message;
        else if (message.documentWithCaptionMessage) message = message.documentWithCaptionMessage.message;
        guard++;
    }
    return message;
}

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
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return Buffer.from(await response.arrayBuffer());
    } catch (e) {
        return null;
    }
}

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

async function humanDelay(minMs = 1500, maxMs = 3500) {
    await delay(Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs);
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
// 🔧 STICKER CONVERSION - FIXED FOR PHONE
// ==========================================
// KEY FIX: WhatsApp phone needs proper WebP with correct metadata
// Problem: Sharp eken generate karana WebP eka phone ekata readable wenne na
// Solution: Explicit format + metadata strip + proper channels
async function convertToSticker(buffer, isVideo = false) {
    if (!sharp) {
        console.log('❌ Sharp not available');
        return null;
    }

    try {
        if (isVideo) {
            // ===== VIDEO → ANIMATED WEBP STICKER =====
            const metadata = await sharp(buffer, { animated: true }).metadata();
            const totalFrames = metadata.pages || 1;
            
            // WhatsApp sticker limits: max 1MB, 512x512, max 5 sec
            const maxFrames = Math.min(totalFrames, 60);

            let result = await sharp(buffer, {
                animated: true,
                limitInputPixels: false,
                pages: maxFrames
            })
            .resize(512, 512, {
                fit: 'contain',
                background: { r: 0, g: 0, b: 0, alpha: 0 }
            })
            // Flatten to ensure alpha channel
            .webp({
                quality: 55,
                effort: 4,
                loop: 0,
                delay: 80,
                lossless: false
            })
            .toBuffer();

            // Size check - reduce if too big
            if (result.length > 900 * 1024) {
                console.log('⚠️ Sticker too large, reducing...');
                result = await sharp(buffer, {
                    animated: true,
                    limitInputPixels: false,
                    pages: Math.min(totalFrames, 30)
                })
                .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .webp({ quality: 35, effort: 4, delay: 100, loop: 0 })
                .toBuffer();
            }

            return result;

        } else {
            // ===== IMAGE → STATIC WEBP STICKER =====
            // CRITICAL FIX: Ensure proper format with explicit RGBA
            const result = await sharp(buffer, { limitInputPixels: false })
                .resize(512, 512, {
                    fit: 'contain',
                    background: { r: 0, g: 0, b: 0, alpha: 0 },
                    withoutEnlargement: false
                })
                .ensureAlpha() // Force RGBA channel
                .webp({
                    quality: 90,
                    effort: 4,
                    lossless: false
                })
                .toBuffer();

            return result;
        }
    } catch (e) {
        console.error('Sticker conversion error:', e.message);
        return null;
    }
}

// ==========================================
// 🔧 TTS Conversion (Already Working)
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
                (error) => error ? reject(error) : resolve()
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
// 🌐 MEDIA DOWNLOAD - NIM API + Fallbacks
// ==========================================

// 🎵 Song/YT Audio
async function getYoutubeAudio(url) {
    // Try 1: NIM API
    try {
        const apiUrl = `${NIM_API_BASE}/api/ytmp3?apiKey=${NIM_API_KEY}&url=${encodeURIComponent(url)}`;
        const res = await axios.get(apiUrl, { timeout: 30000 });
        const dl = res.data?.result?.download_url || res.data?.result?.url || res.data?.data?.url || res.data?.url;
        if (dl && dl.startsWith('http')) {
            console.log('[YT-AUDIO] ✅ NIM API');
            return dl;
        }
    } catch (e) { console.log('[YT-AUDIO] NIM failed:', e.message); }

    // Try 2: yt-dlp
    try {
        const { stdout } = await execPromise(`yt-dlp --get-url -f bestaudio "${url}"`, { timeout: 30000 });
        const dl = stdout.trim().split('\n')[0];
        if (dl && dl.startsWith('http')) {
            console.log('[YT-AUDIO] ✅ yt-dlp');
            return dl;
        }
    } catch (e) {}

    // Try 3: ytdl-core
    try {
        const ytdl = require('@distube/ytdl-core');
        const info = await ytdl.getInfo(url);
        const format = ytdl.chooseFormat(info, { quality: 'highestaudio', filter: 'audioonly' });
        if (format?.url) return format.url;
    } catch (e) {}

    return null;
}

// 🎬 YT Video with quality
async function getYoutubeVideo(url, quality = '720') {
    // Try 1: NIM API
    try {
        const apiUrl = `${NIM_API_BASE}/api/ytmp4?apiKey=${NIM_API_KEY}&url=${encodeURIComponent(url)}&quality=${quality}`;
        const res = await axios.get(apiUrl, { timeout: 30000 });
        const dl = res.data?.result?.download_url || res.data?.result?.url || res.data?.data?.url || res.data?.url;
        if (dl && dl.startsWith('http')) {
            console.log('[YT-VIDEO] ✅ NIM API');
            return dl;
        }
    } catch (e) { console.log('[YT-VIDEO] NIM failed:', e.message); }

    // Try 2: yt-dlp with quality
    try {
        const fmt = quality === '1080' ? 'best[height<=1080]' : quality === '720' ? 'best[height<=720]' : 'best[height<=480]';
        const { stdout } = await execPromise(`yt-dlp --get-url -f "${fmt}[ext=mp4]/best[ext=mp4]" "${url}"`, { timeout: 30000 });
        const dl = stdout.trim().split('\n')[0];
        if (dl && dl.startsWith('http')) {
            console.log('[YT-VIDEO] ✅ yt-dlp');
            return dl;
        }
    } catch (e) {}

    // Try 3: ytdl-core
    try {
        const ytdl = require('@distube/ytdl-core');
        const info = await ytdl.getInfo(url);
        const format = ytdl.chooseFormat(info, { quality: 'highestvideo', filter: 'videoandaudio' });
        if (format?.url) return format.url;
    } catch (e) {}

    return null;
}

// 🎬 TikTok
async function getTikTok(url, quality = 'hd') {
    // Try 1: NIM API
    try {
        const apiUrl = `${NIM_API_BASE}/api/tiktok?apiKey=${NIM_API_KEY}&url=${encodeURIComponent(url)}`;
        const res = await axios.get(apiUrl, { timeout: 30000 });
        const data = res.data?.result || res.data?.data || res.data;
        const dl = quality === 'hd'
            ? (data?.hd || data?.video_hd || data?.video || data?.url || data?.download_url || data?.play)
            : (data?.sd || data?.video_sd || data?.video || data?.url || data?.download_url || data?.play);
        if (dl && typeof dl === 'string' && dl.startsWith('http')) {
            console.log('[TIKTOK] ✅ NIM API');
            return dl;
        }
    } catch (e) { console.log('[TIKTOK] NIM failed:', e.message); }

    // Try 2: tikwm
    try {
        const res = await axios.get(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`, { timeout: 25000 });
        const dl = quality === 'hd' ? (res.data?.data?.hdplay || res.data?.data?.play) : res.data?.data?.play;
        if (dl) {
            return dl.startsWith('http') ? dl : `https://www.tikwm.com${dl}`;
        }
    } catch (e) {}

    // Try 3: yt-dlp
    try {
        const { stdout } = await execPromise(`yt-dlp --get-url "${url}"`, { timeout: 30000 });
        const dl = stdout.trim().split('\n')[0];
        if (dl && dl.startsWith('http')) return dl;
    } catch (e) {}

    return null;
}

// 📘 Facebook
async function getFacebook(url) {
    // Try 1: NIM API
    try {
        const apiUrl = `${NIM_API_BASE}/api/facebook?apiKey=${NIM_API_KEY}&url=${encodeURIComponent(url)}`;
        const res = await axios.get(apiUrl, { timeout: 30000 });
        const dl = res.data?.result?.hd || res.data?.result?.sd || res.data?.result?.url || res.data?.data?.url || res.data?.url;
        if (dl && dl.startsWith('http')) {
            console.log('[FB] ✅ NIM API');
            return dl;
        }
    } catch (e) { console.log('[FB] NIM failed:', e.message); }

    // Try 2: yt-dlp
    try {
        const { stdout } = await execPromise(`yt-dlp --get-url "${url}"`, { timeout: 30000 });
        const dl = stdout.trim().split('\n')[0];
        if (dl && dl.startsWith('http')) return dl;
    } catch (e) {}

    // Try 3: siputzx
    try {
        const res = await axios.get(`https://api.siputzx.my.id/api/d/facebook?url=${encodeURIComponent(url)}`, { timeout: 25000 });
        const dl = res.data?.data?.hd || res.data?.data?.sd || res.data?.url;
        if (dl) return dl;
    } catch (e) {}

    return null;
}

// 📸 Instagram
async function getInstagram(url) {
    // Try 1: NIM API
    try {
        const apiUrl = `${NIM_API_BASE}/api/instagram?apiKey=${NIM_API_KEY}&url=${encodeURIComponent(url)}`;
        const res = await axios.get(apiUrl, { timeout: 30000 });
        const data = res.data?.result || res.data?.data;
        if (Array.isArray(data) && data.length > 0) {
            console.log('[IG] ✅ NIM API (array)');
            return data.map(m => ({
                url: m.url || m.download_url || m.link || m.src,
                type: (m.type || '').toLowerCase().includes('video') || (m.url || '').includes('.mp4') ? 'video' : 'image'
            }));
        }
        if (data?.url) {
            return [{ url: data.url, type: (data.type || '').includes('video') ? 'video' : 'image' }];
        }
    } catch (e) { console.log('[IG] NIM failed:', e.message); }

    // Try 2: siputzx
    try {
        const res = await axios.get(`https://api.siputzx.my.id/api/d/igdl?url=${encodeURIComponent(url)}`, { timeout: 25000 });
        if (res.data?.data && Array.isArray(res.data.data)) {
            return res.data.data.map(m => ({
                url: m.url,
                type: (m.type || '').includes('video') ? 'video' : 'image'
            }));
        }
    } catch (e) {}

    return null;
}

// 🎬 Movie
async function getMovie(query) {
    // Try 1: NIM API
    try {
        const apiUrl = `${NIM_API_BASE}/api/movie?apiKey=${NIM_API_KEY}&q=${encodeURIComponent(query)}`;
        const res = await axios.get(apiUrl, { timeout: 40000 });
        const data = res.data?.result || res.data?.data || res.data;
        
        if (data) {
            if (Array.isArray(data) && data.length > 0) {
                console.log('[MOVIE] ✅ NIM API (array)');
                return data.map(m => ({
                    title: m.title || m.name || 'Unknown',
                    year: m.year,
                    quality: m.quality || 'HD',
                    size: m.size,
                    url: m.url || m.download_url || m.link,
                    poster: m.poster || m.image || m.thumbnail,
                    rating: m.rating
                })).filter(m => m.url);
            }
            if (data.title || data.name) {
                return [{
                    title: data.title || data.name,
                    year: data.year,
                    quality: data.quality || 'HD',
                    size: data.size,
                    url: data.url || data.download_url || data.link,
                    poster: data.poster || data.image,
                    rating: data.rating
                }];
            }
        }
    } catch (e) { console.log('[MOVIE] NIM failed:', e.message); }

    // Try 2: YTS
    try {
        const res = await axios.get(`https://yts.mx/api/v2/list_movies.json?query_term=${encodeURIComponent(query)}&limit=5`, { timeout: 20000 });
        const movies = res.data?.data?.movies;
        if (movies && movies.length > 0) {
            console.log('[MOVIE] ✅ YTS');
            return movies.map(m => ({
                title: m.title,
                year: m.year,
                quality: m.torrents?.[0]?.quality || 'HD',
                size: m.torrents?.[0]?.size || 'N/A',
                url: m.torrents?.[0]?.url || m.url,
                poster: m.medium_cover_image,
                rating: m.rating
            }));
        }
    } catch (e) {}

    return null;
}

// 🤖 AI
async function askAI(query) {
    const apis = [
        { url: `https://api.siputzx.my.id/api/ai/chatgpt?q=${encodeURIComponent(query)}`, extract: (d) => d?.data || d?.response },
        { url: `https://bk9.fun/ai/gemini?q=${encodeURIComponent(query)}`, extract: (d) => d?.result || d?.gpt || d?.answer },
        { url: `https://api.affiliateplus.xyz/api/gpt?query=${encodeURIComponent(query)}`, extract: (d) => d?.reply || d?.response },
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
    const apis = [
        { url: `https://api.siputzx.my.id/api/ai/stable-diffusion?prompt=${encodeURIComponent(prompt)}`, extract: (d) => d?.data?.url || d?.result || d?.url },
        { url: `https://api.nekosia.cat/api/v1/images/text2image?prompt=${encodeURIComponent(prompt)}`, extract: (d) => d?.image?.url || d?.url },
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
    ];
    for (const apiUrl of apis) {
        try {
            const res = await axios.get(apiUrl, { timeout: 20000, responseType: 'arraybuffer' });
            if (res.data && res.data.length > 1000) return Buffer.from(res.data);
        } catch (e) {}
    }
    return null;
}

// ==========================================
// MongoDB Auth
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
                                { creds: credsData, updatedAt: new Date(), lastSeen: new Date() },
                                { upsert: true, new: true }
                            );
                        }
                    }
                } catch (e) {}
            }
        } catch (e) {}
    };

    return { state, saveCreds: enhancedSaveCreds };
}

// ==========================================
// Handle Pending Media (Quality Selection)
// ==========================================
async function handlePendingMedia(socket, sender, msg, reply, pending, choice, channelInfo) {
    const P = pending.type;

    if (P === 'song' || P === 'youtube') {
        const url = P === 'song' ? pending.video.url : pending.url;
        const title = P === 'song' ? pending.video.title : 'YouTube';

        await reply(`📥 Downloading (option ${choice})... ⏳` + FOOTER);

        if (choice === '1') {
            // MP3
            const audioUrl = await getYoutubeAudio(url);
            if (!audioUrl) return reply(`❌ Audio download failed!` + FOOTER);

            try {
                await socket.sendMessage(sender, {
                    audio: { url: audioUrl },
                    mimetype: 'audio/mpeg',
                    ptt: false,
                    fileName: `${title}.mp3`,
                    contextInfo: channelInfo
                }, { quoted: msg });
            } catch (e) {
                await reply(`❌ Send failed: ${e.message}` + FOOTER);
            }
        } else {
            // Video quality
            const quality = choice === '2' ? '360' : choice === '3' ? '720' : '1080';
            const videoUrl = await getYoutubeVideo(url, quality);
            if (!videoUrl) return reply(`❌ Video download failed!` + FOOTER);

            try {
                await socket.sendMessage(sender, {
                    video: { url: videoUrl },
                    caption: `🎬 *${title}*\n📺 ${quality}p` + FOOTER,
                    contextInfo: channelInfo
                }, { quoted: msg });
            } catch (e) {
                await reply(`❌ Send failed: ${e.message}` + FOOTER);
            }
        }
    } 
    else if (P === 'tiktok') {
        await reply(`📥 Downloading (option ${choice})... ⏳` + FOOTER);

        if (choice === '3') {
            // Audio only
            const videoUrl = await getTikTok(pending.url, 'hd');
            if (!videoUrl) return reply(`❌ Download failed!` + FOOTER);
            
            await socket.sendMessage(sender, {
                video: { url: videoUrl },
                caption: `🎬 *TikTok*\n⚠️ Video only (audio extract not supported)` + FOOTER,
                contextInfo: channelInfo
            }, { quoted: msg });
        } else {
            const quality = choice === '1' ? 'hd' : 'sd';
            const videoUrl = await getTikTok(pending.url, quality);
            if (!videoUrl) return reply(`❌ Download failed!` + FOOTER);

            await socket.sendMessage(sender, {
                video: { url: videoUrl },
                caption: `🎬 *TikTok ${quality.toUpperCase()}*` + FOOTER,
                contextInfo: channelInfo
            }, { quoted: msg });
        }
    }
    else if (P === 'movie') {
        const idx = parseInt(choice) - 1;
        const movie = pending.movies[idx];
        if (!movie) return reply(`❌ Invalid selection!` + FOOTER);

        await reply(`📥 Downloading: *${movie.title}*... ⏳` + FOOTER);

        if (!movie.url) return reply(`❌ No download link for this movie!` + FOOTER);

        try {
            // Send as document (movie files are large)
            await socket.sendMessage(sender, {
                document: { url: movie.url },
                mimetype: 'video/mp4',
                fileName: `${movie.title}${movie.year ? ` (${movie.year})` : ''}.mp4`,
                caption: `🎬 *${movie.title}*\n📺 ${movie.quality || 'HD'}\n💾 ${movie.size || 'N/A'}` + FOOTER,
                contextInfo: channelInfo
            }, { quoted: msg });
        } catch (e) {
            await reply(`❌ Send failed: ${e.message}\n\n💡 Link: ${movie.url}` + FOOTER);
        }
    }
}

// ==========================================
// Setup Command Handlers
// ==========================================
function setupCommandHandlers(socket, number) {

    // Anti-Delete Handler
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
                if (!revokedId && updateData?.messageStubType === 1) revokedId = key?.id;
                if (!revokedId && updateData?.message === null && key?.id) revokedId = key.id;
                if (!revokedId) continue;

                let cachedMsg = messageCache.get(revokedId);
                if (!cachedMsg) {
                    for (const [k, v] of messageCache) {
                        if (v?.key?.id === revokedId || v?.key?.stanzaId === revokedId) {
                            cachedMsg = v;
                            break;
                        }
                    }
                }
                if (!cachedMsg) continue;

                const chatJid = cachedMsg.key.remoteJid;
                const senderJid = cachedMsg.key.participant || cachedMsg.key.remoteJid;
                const messageText = getMessageBody(cachedMsg) || '[Media]';

                deletedMessages.set(chatJid, {
                    sender: senderJid, text: messageText,
                    time: new Date().toLocaleString(),
                    originalMsg: cachedMsg, keyId: revokedId, timestamp: Date.now()
                });

                let nodeleteStatus = chatNodelete.get(chatJid);
                if (nodeleteStatus === undefined || nodeleteStatus === null) {
                    try { nodeleteStatus = await get(`NODELETE_${chatJid}`, number); } catch (e) {}
                    if (!nodeleteStatus) {
                        try {
                            const cleanKey = chatJid.replace(/[^0-9]/g, '');
                            nodeleteStatus = await get(`NODELETE_${cleanKey}`, number);
                        } catch (e) {}
                    }
                    nodeleteStatus = nodeleteStatus || 'off';
                    chatNodelete.set(chatJid, nodeleteStatus);
                }

                if (nodeleteStatus === 'on') {
                    try {
                        const senderName = senderJid.split('@')[0];
                        await sendWithTyping(socket, chatJid, {
                            text: `🗑️ *DELETED MESSAGE DETECTED!*\n\n👤 *Sender:* @${senderName}\n⏰ *Time:* ${new Date().toLocaleString()}\n💬 *Message:*\n${messageText}\n\n> _Auto-recovered_${FOOTER}`,
                            mentions: [senderJid],
                            contextInfo: getChannelContext()
                        });
                    } catch (e) {}
                }
            }
        } catch (e) {}
    });

    // Main handler
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
        const senderJid = msg.key.participant || sender;
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
                    const emojis = ['✅', '👌', '🔥', '⚡'];
                    await socket.sendMessage(sender, { react: { text: emojis[Math.floor(Math.random() * emojis.length)], key: msg.key } });
                } catch (e) {}
            }
            return sentMsg;
        };

        // ==========================================
        // AUTO-SAVE
        // ==========================================
        if (!msg.key.fromMe && !sender.endsWith('@g.us') && !sender.endsWith('@broadcast') && !sender.endsWith('@newsletter')) {
            try {
                const autoSaveStatus = await get('AUTOSAVE_STATUS', number);
                if (autoSaveStatus === 'on' || autoSaveStatus === 'true') {
                    const autoSaveName = await get('AUTOSAVE_NAME', number) || 'Saved Contact';
                    
                    try {
                        // addOrEditContact saves contact in WhatsApp phonebook
                        await socket.addOrEditContact(sender, {
                            firstName: autoSaveName
                        });
                        console.log(`[AUTOSAVE] ✅ Saved ${sender} as "${autoSaveName}"`);
                    } catch (saveErr) {
                        // Contact may already exist, which is fine
                    }
                }
            } catch (e) {}
        }

        // Anti-Link
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
                                    text: `🚫 *LINK DETECTED!*\n\n👤 @${userName}\n⚡️ Links not allowed!` + FOOTER,
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
        // PENDING MEDIA REPLY (Quality Selection)
        // ==========================================
        if (!isCommand && pendingMediaRequests.has(sender)) {
            const pending = pendingMediaRequests.get(sender);
            const numReply = body.trim();
            
            if (['1', '2', '3', '4', '5'].includes(numReply)) {
                if (Date.now() - pending.timestamp > 5 * 60 * 1000) {
                    pendingMediaRequests.delete(sender);
                } else {
                    try {
                        pendingMediaRequests.delete(sender);
                        await handlePendingMedia(socket, sender, msg, reply, pending, numReply, channelInfo);
                        return;
                    } catch (e) {
                        console.error('Pending media error:', e);
                        pendingMediaRequests.delete(sender);
                        await reply(`❌ ${e.message}` + FOOTER);
                    }
                }
            }
        }

        // Menu Reply Handler
        const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
        const quotedStanzaId = contextInfo?.stanzaId || '';
        let quotedText = '';
        const qm = contextInfo?.quotedMessage || {};
        if (qm.conversation) quotedText = qm.conversation;
        else if (qm.extendedTextMessage?.text) quotedText = qm.extendedTextMessage.text;
        else if (qm.imageMessage?.caption) quotedText = qm.imageMessage.caption;
        else if (qm.videoMessage?.caption) quotedText = qm.videoMessage.caption;

        const isBotMenuMessage = quotedStanzaId && menuMessageIds.has(quotedStanzaId);
        const hasMenuKeywords = quotedText.includes('𝗠𝗔𝗜𝗡 𝗠𝗘𝗡𝗨') || 
                               quotedText.includes('Reply to this message with a number') ||
                               (quotedText.includes('1️⃣') && quotedText.includes('2️⃣'));
        const isMenuReply = isBotMenuMessage || hasMenuKeywords;

        if (!isCommand && body.match(/^[1-7]$/) && isMenuReply) {
            const categoryNum = parseInt(body);
            let categoryMenu = '';
            switch(categoryNum) {
                case 1: categoryMenu = `*╭─\`📥 DOWNLOAD COMMANDS\`┤⭓*\n*┃*\n*┃ 🎵 .song [name]*\n*┃ 🎬 .tt [url]*\n*┃ 🎬 .yt [url]*\n*┃ 🎬 .fb [url]*\n*┃ 📸 .ig [url]*\n*┃ 🎬 .movie [name]*\n*┃ 🔗 .tourl*\n*┃ 📸 .vv / .vvp*\n*┃ 📥 .send*\n*╰──────────────────────*\n\n💡 *Reply 0 to go back*`; break;
                case 2: categoryMenu = `*╭─\`⚙️ SETTINGS COMMANDS\`┤⭓*\n*┃*\n*┃ 📋 .settings*\n*┃ 🔐 .mode*\n*┃ 👁️ .autoread*\n*┃ 🤖 .autoreply*\n*┃ 💾 .autosave*\n*┃ 📷 .autoview*\n*┃ ❤️ .autolike*\n*┃ 🟢 .alwaysonline*\n*┃ 🔗 .antilink*\n*┃ 👋 .welcome*\n*┃ 🗑️ .nodelet*\n*┃ 🔤 .setprefix*\n*╰──────────────────────*\n\n💡 *Reply 0 to go back*`; break;
                case 3: categoryMenu = `*╭─\`👑 OWNER COMMANDS\`┤⭓*\n*┃*\n*┃ 🔒 .Nimsara*\n*┃ 👤 .owner*\n*┃ 📊 .active*\n*┃ 🔗 .pair*\n*┃ 📞 .vvpowner*\n*╰──────────────────────*\n\n💡 *Reply 0 to go back*`; break;
                case 4: categoryMenu = `*╭─\`🛠️ UTILITY COMMANDS\`┤⭓*\n*┃*\n*┃ 🏓 .ping*\n*┃ ⏱️ .runtime*\n*┃ 🕐 .time*\n*┃ 📍 .jid*\n*┃ ❤️ .alive*\n*┃ 🗑️ .remsg*\n*┃ 👤 .whois*\n*┃ 🔐 .password*\n*┃ 🔗 .short*\n*┃ 📱 .qr*\n*┃ 🌍 .weather*\n*┃ 🌐 .ip*\n*┃ 🔐 .base64*\n*┃ ✅ .check*\n*┃ 💰 .crypto*\n*╰──────────────────────*\n\n💡 *Reply 0 to go back*`; break;
                case 5: categoryMenu = `*╭─\`🤖 AI & CONVERT\`┤⭓*\n*┃*\n*┃ 🤖 .ai*\n*┃ 🌐 .tr*\n*┃ 🎨 .imagine*\n*┃ 📸 .sticker*\n*┃ 📱 .fakechat*\n*┃ 📸 .ss*\n*┃ 🎤 .tts*\n*┃ 🎨 .textimg*\n*╰──────────────────────*\n\n💡 *Reply 0 to go back*`; break;
                case 6: categoryMenu = `*╭─\`👑 GROUP ADMIN\`┤⭓*\n*┃*\n*┃ 📢 .tagall*\n*┃ 👢 .kick*\n*┃ 👑 .promote*\n*┃ 👤 .demote*\n*┃ 🔇 .mute*\n*┃ 🔊 .unmute*\n*┃ 📊 .ginfo*\n*┃ 📊 .poll*\n*┃ 📞 .getcontact*\n*╰──────────────────────*\n\n💡 *Reply 0 to go back*`; break;
                case 7: categoryMenu = `*╭─\`🎮 FUN COMMANDS\`┤⭓*\n*┃*\n*┃ 🔥 .quote*\n*┃ 🎲 .dice*\n*┃ 🪙 .flip*\n*┃ 😂 .joke*\n*┃ 🔢 .random*\n*┃ 🎂 .bday*\n*╰──────────────────────*\n\n💡 *Reply 0 to go back*`; break;
                default: return;
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

        if (!isCommand && body === '0' && isMenuReply) {
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
─────────────────────

*╭─\`𝗠𝗔𝗜𝗡 𝗠𝗘𝗡𝗨 𝗖𝗔𝗧𝗘𝗚𝗢𝗥𝗜𝗘𝗦\`┤⭓*
*┃*
*┃ 1️⃣ - 📥 DOWNLOAD*
*┃ 2️⃣ - ⚙️ SETTINGS*
*┃ 3️⃣ - 👑 OWNER*
*┃ 4️⃣ - 🛠️ UTILITY*
*┃ 5️⃣ - 🤖 AI & CONVERT*
*┃ 6️⃣ - 👑 GROUP ADMIN*
*┃ 7️⃣ - 🎮 FUN*
*┃*
*╰──────────────────────*

💡 *Reply with a number!*

> 🔗 Web: https://nimsara-official.vercel.app/
> *📢 CHANNEL :- ${BOT_CHANNEL_LINK}*

> _© ᴄʀᴇᴀᴛᴏʀ ʙY ɴɪᴍꜱᴀʀᴀ 🥷🏻_`;

            const sentMsg = await socket.sendMessage(sender, {
                image: { url: BOT_IMAGE_URL },
                caption: mainMenu.trim(),
                contextInfo: channelInfo
            }, { quoted: msg });
            if (sentMsg?.key?.id) menuMessageIds.set(sentMsg.key.id, { type: 'main' });
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
                global.customReplies = global.customReplies || {};
                if (global.customReplies[textLower]) {
                    await reply(global.customReplies[textLower] + FOOTER);
                    return;
                }

                const words = textLower.split(/\s+/).filter(w => w.length > 0);
                const hasExactWord = (keyword) => words.includes(keyword);

                if (hasExactWord('hi') || hasExactWord('හායි') || hasExactWord('hello')) {
                    await reply('Hi! 👋' + FOOTER);
                } else if (hasExactWord('mk') || textLower === 'මොකද කරන්නේ') {
                    await reply('Mokuth Na innwa😊' + FOOTER);
                } else if (hasExactWord('gm') || textLower === 'good morning') {
                    await reply('Good Morning🌝' + FOOTER);
                } else if (hasExactWord('gn') || textLower === 'good night') {
                    await reply('Good Night✨' + FOOTER);
                } else if (hasExactWord('bye') || hasExactWord('බායි')) {
                    await reply('Bye🍻' + FOOTER);
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

                // ==========================================
                // 🔒 .Nimsara - OWNER-ONLY SETTINGS
                // ==========================================
                case 'nimsara': {
                    // Check if sender is one of the 3 owner numbers
                    if (!isOwnerNumber(senderJid) && !msg.key.fromMe) {
                        return reply(`⛔ *Access Denied!*\n\n💡 This command is for Owner only!` + FOOTER);
                    }

                    const subCmd = args[0]?.toLowerCase();

                    if (!subCmd) {
                        const bName = await get('BOT_NAME', number) || 'NIM BOT';
                        const pfx = await get('PREFIX', number) || '.';
                        const logoUrl = await get('BOT_LOGO_URL', number) || BOT_IMAGE_URL;
                        const autoSave = await get('AUTOSAVE_STATUS', number) || 'off';
                        const autoSaveName = await get('AUTOSAVE_NAME', number) || 'Saved Contact';
                        
                        return reply(`🔒 *NIMSARA OWNER PANEL*

📊 *Current Settings:*
📝 Name: *${bName}*
🔤 Prefix: *${pfx}*
💾 AutoSave: *${autoSave}*
📛 AutoSave Name: *${autoSaveName}*

*Commands:*
• \`.Nimsara setname [name]\` - Change bot name
• \`.Nimsara setlogo [url]\` - Change bot logo
• \`.Nimsara setprefix [prefix]\` - Change prefix
• \`.Nimsara info\` - Show bot info
• \`.Nimsara numbers\` - Show owner numbers

💡 *Only 3 Owner Numbers:*
• 94784280074
• 94740532742
• 94701726411` + FOOTER);
                    }

                    if (subCmd === 'setname' || subCmd === 'setbotname') {
                        const newName = args.slice(1).join(' ');
                        if (!newName) return reply(`⚠️ Usage: .Nimsara setname [New Bot Name]` + FOOTER);
                        if (newName.length > 30) return reply(`⚠️ Max 30 characters!` + FOOTER);
                        await handleSettingUpdate("BOT_NAME", newName, reply, number);
                        await reply(`✅ *BOT NAME UPDATED!*\n\n📝 New Name: *${newName}*` + FOOTER);
                        return;
                    }

                    if (subCmd === 'setlogo') {
                        let logoUrl = args[1];

                        // Support reply-to-image
                        if (!logoUrl || logoUrl === 'reply') {
                            const quoted = msg.message?.extendedTextMessage?.contextInfo;
                            if (quoted?.quotedMessage?.imageMessage) {
                                try {
                                    const downloadMsg = {
                                        key: { remoteJid: quoted.remoteJid || sender, id: quoted.stanzaId, participant: quoted.participant },
                                        message: { imageMessage: quoted.quotedMessage.imageMessage }
                                    };
                                    const buffer = await downloadMediaMessage(downloadMsg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                                    
                                    // Upload to catbox
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
                                    return reply(`❌ Logo upload failed: ${e.message}` + FOOTER);
                                }
                            }
                        }

                        if (!logoUrl || !logoUrl.startsWith('http')) {
                            return reply(`⚠️ Usage:\n\`.Nimsara setlogo [image URL]\`\nOR reply to image with \`.Nimsara setlogo reply\`` + FOOTER);
                        }

                        await handleSettingUpdate("BOT_LOGO_URL", logoUrl, reply, number);
                        await reply(`✅ *BOT LOGO UPDATED!*\n\n🖼️ URL saved!` + FOOTER);
                        return;
                    }

                    if (subCmd === 'setprefix') {
                        const newPrefix = args[1];
                        if (!newPrefix) return reply(`⚠️ Usage: .Nimsara setprefix [prefix]` + FOOTER);
                        await handleSettingUpdate("PREFIX", newPrefix, reply, number);
                        await reply(`✅ *PREFIX UPDATED!*\n\n🔤 New Prefix: *${newPrefix}*` + FOOTER);
                        return;
                    }

                    if (subCmd === 'info') {
                        const bName = await get('BOT_NAME', number) || 'NIM BOT';
                        const pfx = await get('PREFIX', number) || '.';
                        const logoUrl = await get('BOT_LOGO_URL', number) || BOT_IMAGE_URL;
                        const autoSave = await get('AUTOSAVE_STATUS', number) || 'off';
                        const autoSaveName = await get('AUTOSAVE_NAME', number) || 'Saved Contact';

                        await reply(`ℹ️ *BOT INFO*

📝 Name: *${bName}*
🔤 Prefix: *${pfx}*
🖼️ Logo: ${logoUrl}
💾 AutoSave: *${autoSave}*
📛 AutoSave Name: *${autoSaveName}*
🔢 Bot Number: *${number}*
👑 Owner Numbers: 3` + FOOTER);
                        return;
                    }

                    if (subCmd === 'numbers') {
                        await reply(`👑 *OWNER NUMBERS (3)*\n\n1️⃣ 94784280074\n2️⃣ 94740532742\n3️⃣ 94701726411\n\n💡 Only these numbers can use \`.Nimsara\` command!` + FOOTER);
                        return;
                    }

                    return reply(`⚠️ Unknown subcommand!\n\nUse \`.Nimsara\` to see all commands.` + FOOTER);
                }

                // ==========================================
                // 💾 AUTOSAVE
                // ==========================================
                case 'autosave': {
                    if (!msg.key.fromMe && !isOwnerNumber(senderJid)) {
                        return reply(`⚠️ Only Bot Owner!` + FOOTER);
                    }

                    const subCmd = args[0]?.toLowerCase();
                    const currentStatus = await get('AUTOSAVE_STATUS', number) || 'off';
                    const currentName = await get('AUTOSAVE_NAME', number) || 'Saved Contact';

                    if (!subCmd || !['on', 'off', 'setname', 'status'].includes(subCmd)) {
                        return reply(`💾 *AUTOSAVE SETTINGS*

📊 Status: *${currentStatus.toUpperCase()}*
📛 Save Name: *${currentName}*

*Commands:*
• \`.autosave on\` - Enable
• \`.autosave off\` - Disable
• \`.autosave setname [name]\` - Set name
• \`.autosave status\` - Show status

💡 When ON, unsaved numbers will be auto-saved with the configured name!` + FOOTER);
                    }

                    if (subCmd === 'on') {
                        await handleSettingUpdate("AUTOSAVE_STATUS", "on", reply, number);
                        await reply(`✅ *AUTOSAVE ENABLED!*\n\n📛 Contacts will save as: *${currentName}*` + FOOTER);
                        return;
                    }

                    if (subCmd === 'off') {
                        await handleSettingUpdate("AUTOSAVE_STATUS", "off", reply, number);
                        await reply(`✅ *AUTOSAVE DISABLED!*` + FOOTER);
                        return;
                    }

                    if (subCmd === 'setname') {
                        const newName = args.slice(1).join(' ');
                        if (!newName) return reply(`⚠️ Usage: .autosave setname [name]` + FOOTER);
                        if (newName.length > 50) return reply(`⚠️ Max 50 characters!` + FOOTER);
                        await handleSettingUpdate("AUTOSAVE_NAME", newName, reply, number);
                        await reply(`✅ *AUTOSAVE NAME UPDATED!*\n\n📛 New name: *${newName}*` + FOOTER);
                        return;
                    }

                    if (subCmd === 'status') {
                        await reply(`💾 *AUTOSAVE STATUS*\n\n📊 Status: *${currentStatus.toUpperCase()}*\n📛 Name: *${currentName}*` + FOOTER);
                        return;
                    }
                    return;
                }

                // ==========================================
                // 🎵 SONG / YT
                // ==========================================
                case 'song':
                case 'play': {
                    const query = args.join(' ');
                    if (!query) return reply(`⚠️ Usage: .song [song name]` + FOOTER);

                    await reply(`🔍 Searching: *${query}*... 🎶` + FOOTER);

                    try {
                        const search = await yts(query);
                        const video = search.videos[0];
                        if (!video) return reply(`❌ Not found!` + FOOTER);

                        const infoMsg = `🎵 *SONG FOUND*

📝 *Title:* ${video.title}
⏱️ *Duration:* ${video.timestamp}
👤 *Channel:* ${video.author.name}

📥 *Choose format:*
*1️⃣* MP3 (Audio)
*2️⃣* MP4 360p
*3️⃣* MP4 720p

💡 *Reply with a number!*` + FOOTER;

                        const sent = await socket.sendMessage(sender, {
                            image: { url: video.thumbnail },
                            caption: infoMsg,
                            contextInfo: channelInfo
                        }, { quoted: msg });

                        pendingMediaRequests.set(sender, {
                            type: 'song',
                            video: video,
                            timestamp: Date.now(),
                            menuMsgId: sent?.key?.id
                        });
                    } catch (e) {
                        await reply(`❌ Failed: ${e.message}` + FOOTER);
                    }
                    break;
                }

                // ==========================================
                // 🎬 YOUTUBE
                // ==========================================
                case 'yt':
                case 'youtube': {
                    const url = args[0];
                    if (!url || (!url.includes('youtube.com') && !url.includes('youtu.be'))) {
                        return reply(`⚠️ Usage: .yt [YouTube URL]` + FOOTER);
                    }

                    await reply(`📥 Getting info... ⏳` + FOOTER);

                    try {
                        const ytdl = require('@distube/ytdl-core');
                        const info = await ytdl.getBasicInfo(url);
                        const title = info.videoDetails.title;
                        const thumbnail = info.videoDetails.thumbnails[0]?.url;

                        const infoMsg = `🎬 *YOUTUBE VIDEO*

📝 *Title:* ${title}

📥 *Choose format:*
*1️⃣* MP3 (Audio)
*2️⃣* MP4 360p
*3️⃣* MP4 720p
*4️⃣* MP4 1080p

💡 *Reply with a number!*` + FOOTER;

                        await socket.sendMessage(sender, {
                            image: { url: thumbnail },
                            caption: infoMsg,
                            contextInfo: channelInfo
                        }, { quoted: msg });

                        pendingMediaRequests.set(sender, {
                            type: 'youtube',
                            url: url,
                            title: title,
                            timestamp: Date.now()
                        });
                    } catch (e) {
                        await reply(`❌ Failed: ${e.message}` + FOOTER);
                    }
                    break;
                }

                // ==========================================
                // 🎬 TIKTOK
                // ==========================================
                case 'tt':
                case 'tiktok': {
                    const url = args[0];
                    if (!url || !url.includes('tiktok.com')) {
                        return reply(`⚠️ Usage: .tt [TikTok URL]` + FOOTER);
                    }

                    await reply(`🎬 *TIKTOK VIDEO*\n\n📥 *Choose quality:*\n\n*1️⃣* HD (No Watermark)\n*2️⃣* SD (No Watermark)\n\n💡 *Reply with a number!*` + FOOTER);

                    pendingMediaRequests.set(sender, {
                        type: 'tiktok',
                        url: url,
                        timestamp: Date.now()
                    });
                    break;
                }

                // ==========================================
                // 📘 FACEBOOK
                // ==========================================
                case 'fb':
                case 'facebook': {
                    const url = args[0];
                    if (!url || (!url.includes('facebook.com') && !url.includes('fb.watch') && !url.includes('fb.me'))) {
                        return reply(`⚠️ Usage: .fb [Facebook URL]` + FOOTER);
                    }

                    await reply(`📥 Processing Facebook... ⏳` + FOOTER);

                    try {
                        const videoUrl = await getFacebook(url);
                        if (!videoUrl) return reply(`❌ Download failed!` + FOOTER);

                        await socket.sendMessage(sender, {
                            video: { url: videoUrl },
                            caption: `🎬 *Facebook Video*` + FOOTER,
                            contextInfo: channelInfo
                        }, { quoted: msg });
                    } catch (e) {
                        await reply(`❌ Error: ${e.message}` + FOOTER);
                    }
                    break;
                }

                // ==========================================
                // 📸 INSTAGRAM
                // ==========================================
                case 'ig':
                case 'instagram': {
                    const url = args[0];
                    if (!url || !url.includes('instagram.com')) {
                        return reply(`⚠️ Usage: .ig [Instagram URL]` + FOOTER);
                    }

                    await reply(`📥 Processing Instagram... ⏳` + FOOTER);

                    try {
                        const mediaData = await getInstagram(url);
                        if (!mediaData || mediaData.length === 0) {
                            return reply(`❌ Download failed!` + FOOTER);
                        }

                        for (const media of mediaData) {
                            if (!media.url) continue;

                            try {
                                if (media.type === 'video' || media.url.includes('.mp4')) {
                                    await socket.sendMessage(sender, {
                                        video: { url: media.url },
                                        caption: `📸 *Instagram Video*` + FOOTER,
                                        contextInfo: channelInfo
                                    }, { quoted: msg });
                                } else {
                                    await socket.sendMessage(sender, {
                                        image: { url: media.url },
                                        caption: `📸 *Instagram Image*` + FOOTER,
                                        contextInfo: channelInfo
                                    }, { quoted: msg });
                                }
                                await delay(500);
                            } catch (e) {
                                console.log('[IG] Send failed:', e.message);
                            }
                        }
                    } catch (e) {
                        await reply(`❌ Error: ${e.message}` + FOOTER);
                    }
                    break;
                }

                // ==========================================
                // 🎬 MOVIE
                // ==========================================
                case 'movie':
                case 'film': {
                    const query = args.join(' ');
                    if (!query) return reply(`⚠️ Usage: .movie [movie name]` + FOOTER);

                    await reply(`🔍 Searching: *${query}*... 🎬` + FOOTER);

                    try {
                        const movies = await getMovie(query);
                        if (!movies || movies.length === 0) {
                            return reply(`❌ Movie not found!` + FOOTER);
                        }

                        let movieList = `🎬 *MOVIE RESULTS*\n\n`;
                        movies.slice(0, 5).forEach((m, i) => {
                            movieList += `*${i + 1}️⃣* ${m.title}${m.year ? ` (${m.year})` : ''}\n`;
                            if (m.quality) movieList += `   📺 Quality: ${m.quality}\n`;
                            if (m.size) movieList += `   💾 Size: ${m.size}\n`;
                            if (m.rating) movieList += `   ⭐ Rating: ${m.rating}\n`;
                            movieList += `\n`;
                        });
                        movieList += `💡 *Reply with a number to download!*` + FOOTER;

                        // Send with poster if available
                        const firstMovie = movies[0];
                        if (firstMovie?.poster) {
                            await socket.sendMessage(sender, {
                                image: { url: firstMovie.poster },
                                caption: movieList,
                                contextInfo: channelInfo
                            }, { quoted: msg });
                        } else {
                            await reply(movieList);
                        }

                        pendingMediaRequests.set(sender, {
                            type: 'movie',
                            movies: movies,
                            timestamp: Date.now()
                        });
                    } catch (e) {
                        await reply(`❌ Failed: ${e.message}` + FOOTER);
                    }
                    break;
                }

                // ==========================================
                // 🎨 STICKER (FIXED)
                // ==========================================
                case 'sticker':
                case 's': {
                    try {
                        const quoted = msg.message?.extendedTextMessage?.contextInfo;
                        if (!quoted?.quotedMessage) {
                            return reply(`⚠️ Reply to image/video with .sticker` + FOOTER);
                        }

                        let qMsg = unwrapMessage(quoted.quotedMessage);
                        if (!qMsg) return reply(`⚠️ Could not read quoted message!` + FOOTER);

                        const mediaInfo = getMediaType(qMsg);
                        if (!mediaInfo) return reply(`⚠️ Reply to image/video only!` + FOOTER);

                        const { type: messageType, data: mediaData } = mediaInfo;
                        const isVideo = messageType === 'videoMessage';

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

                        // 🔧 FIX: Send as sticker - do NOT set mimetype, baileys handles it
                        await socket.sendMessage(sender, {
                            sticker: stickerBuffer
                        }, { quoted: msg });

                        console.log(`[STICKER] ✅ ${isVideo ? 'video' : 'image'} - ${stickerBuffer.length} bytes`);

                    } catch (e) {
                        console.error('[STICKER] Error:', e);
                        await reply(`❌ Sticker failed: ${e.message}` + FOOTER);
                    }
                    break;
                }

                // ==========================================
                // 🎤 TTS
                // ==========================================
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

                        for (let i = 0; i < textChunks.length; i++) {
                            const chunk = textChunks[i];
                            const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(chunk)}&tl=en&client=tw-ob&total=${textChunks.length}&idx=${i}&textlen=${chunk.length}`;

                            const response = await axios.get(ttsUrl, {
                                responseType: 'arraybuffer',
                                timeout: 20000,
                                headers: {
                                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                                    'Referer': 'https://translate.google.com/'
                                }
                            });

                            const mp3Buffer = Buffer.from(response.data);
                            if (mp3Buffer.length < 500) continue;

                            const opusBuffer = await convertTtsToOpus(mp3Buffer);

                            if (opusBuffer && opusBuffer.length > 500) {
                                await socket.sendMessage(sender, {
                                    audio: opusBuffer,
                                    mimetype: 'audio/ogg; codecs=opus',
                                    ptt: true,
                                    contextInfo: channelInfo
                                }, { quoted: msg });
                            } else {
                                await socket.sendMessage(sender, {
                                    audio: mp3Buffer,
                                    mimetype: 'audio/mpeg',
                                    ptt: true,
                                    contextInfo: channelInfo
                                }, { quoted: msg });
                            }

                            if (textChunks.length > 1) await delay(1000);
                        }
                    } catch (e) {
                        await reply(`❌ TTS failed: ${e.message}` + FOOTER);
                    }
                    break;
                }

                // AI
                case 'ai':
                case 'gpt': {
                    const query = args.join(' ');
                    if (!query) return reply(`⚠️ Provide a question!` + FOOTER);
                    await reply(`🤖 Thinking... 🤔` + FOOTER);
                    const answer = await askAI(query);
                    if (!answer) return reply(`❌ AI failed!` + FOOTER);
                    await reply(`🤖 *AI*\n\n${answer.trim()}` + FOOTER);
                    break;
                }

                // IMAGINE
                case 'imagine':
                case 'aiimage': {
                    const prompt = args.join(' ');
                    if (!prompt) return reply(`⚠️ Usage: .imagine [prompt]` + FOOTER);
                    await reply(`🎨 Generating... ⏳` + FOOTER);
                    const imageUrl = await generateAIImage(prompt);
                    if (!imageUrl) return reply(`❌ Failed!` + FOOTER);
                    await socket.sendMessage(sender, {
                        image: { url: imageUrl },
                        caption: `🎨 *AI Image*\n\n📝 ${prompt}` + FOOTER,
                        contextInfo: channelInfo
                    }, { quoted: msg });
                    break;
                }

                // FAKECHAT
                case 'fakechat': {
                    const text = args.join(' ');
                    if (!text || !text.includes('|')) return reply(`⚠️ Usage: .fakechat Name|Message` + FOOTER);
                    const [name, ...msgParts] = text.split('|');
                    const message = msgParts.join('|');
                    await reply(`📱 Generating... ⏳` + FOOTER);
                    const buf = await generateFakeChat(name, message);
                    if (!buf) return reply(`❌ Failed!` + FOOTER);
                    await socket.sendMessage(sender, {
                        image: buf,
                        caption: `📱 *Fake Chat*` + FOOTER,
                        contextInfo: channelInfo
                    }, { quoted: msg });
                    break;
                }

                // Pair
                case 'pair':
                case 'paircode': {
                    if (!msg.key.fromMe) return reply(`⚠️ Only Bot Owner!` + FOOTER);
                    const targetNumber = args[0]?.replace(/[^0-9]/g, '');
                    if (!targetNumber) return reply(`⚠️ Usage: .pair [number]` + FOOTER);
                    await reply(`🔄 Generating Pair Code...\n\n📱 ${targetNumber}` + FOOTER);
                    try {
                        const sessionDir = path.join(SESSION_BASE_PATH, `temp_session_${targetNumber}`);
                        await fs.ensureDir(sessionDir);
                        const { state: tempState, saveCreds: tempSaveCreds } = await useMultiFileAuthState(sessionDir);
                        const tempLogger = pino({ level: 'silent' });
                        const tempSock = makeWASocket({
                            auth: { creds: tempState.creds, keys: makeCacheableSignalKeyStore(tempState.keys, tempLogger) },
                            printQRInTerminal: false, logger: tempLogger, browser: Browsers.macOS('Safari')
                        });
                        tempSock.ev.on('creds.update', tempSaveCreds);
                        if (!tempSock.authState.creds.registered) {
                            await delay(3000);
                            const code = await tempSock.requestPairingCode(targetNumber);
                            const fmt = code?.match(/.{1,4}/g)?.join('-') || code;
                            await reply(`✅ *PAIR CODE*\n\n📱 ${targetNumber}\n🔑 \`${fmt}\`\n\n💡 WhatsApp → Linked Devices` + FOOTER);
                        }
                        setTimeout(async () => {
                            try { await tempSock.end(); } catch (e) {}
                            try { await fs.remove(sessionDir); } catch (e) {}
                        }, 60000);
                    } catch (err) {
                        await reply(`❌ ${err.message}` + FOOTER);
                    }
                    break;
                }

                // Active
                case 'active':
                case 'activeusers': {
                    if (!msg.key.fromMe && !isOwnerNumber(senderJid)) return reply(`⚠️ Only Owner!` + FOOTER);
                    try {
                        const allSessions = await Session.find({});
                        const active = Array.from(activeSockets.keys());
                        let t = `📊 *ACTIVE USERS*\n\n📱 Connected: ${active.length}\n💾 Sessions: ${allSessions.length}\n\n`;
                        active.forEach((num, i) => {
                            const start = socketCreationTime.get(num);
                            const uptime = start ? Math.floor((Date.now() - start) / 1000) : 0;
                            t += `${i + 1}. +${num} (${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m)\n`;
                        });
                        await reply(t + FOOTER);
                    } catch (e) { await reply(`❌ ${e.message}` + FOOTER); }
                    break;
                }

                // JID
                case 'jid': {
                    await reply(`📍 *JID INFO*\n\n💬 Chat: \`${msg.key.remoteJid}\`\n👤 Sender: \`${msg.key.participant || msg.key.remoteJid}\`` + FOOTER);
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

                // Runtime
                case 'runtime': {
                    const start = socketCreationTime.get(number) || Date.now();
                    const uptime = Math.floor((Date.now() - start) / 1000);
                    await reply(`⏱️ *Uptime:* ${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s` + FOOTER);
                    break;
                }

                // Owner
                case 'owner': {
                    await reply(`👑 *Bot Owner*\n> Name: Nimsara\n> Contact: 0784280074\n> Bot: ${botName}` + FOOTER);
                    break;
                }

                // Alive
                case 'alive':
                case 'status': {
                    const start = socketCreationTime.get(number) || Date.now();
                    const uptime = Math.floor((Date.now() - start) / 1000);
                    await socket.sendMessage(sender, {
                        image: { url: BOT_IMAGE_URL },
                        caption: `👋 *${botName}* online!\n⏱️ ${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s\n👨‍💻 Nimsara` + FOOTER,
                        contextInfo: channelInfo
                    }, { quoted: msg });
                    break;
                }

                // Menu
                case 'allmenu':
                case 'menu':
                case 'help': {
                    const bN = await get('BOT_NAME', number) || 'NIM BOT';
                    const isFollowing = await checkChannelFollow(socket, msg.key.participant || sender);
                    const followStatus = isFollowing ? '✅ Followed' : '❌ Not Followed';

                    const captionText = `
*👋 ${bN.toUpperCase()} 🧃🇱🇰*
*-- The Mini Whatsapp Bot Experience --*

> © ᴄʀᴇᴀᴛᴏʀ ʙY ɴɪᴍꜱᴀʀᴀ 🥷🏻
> 🪀 Contact - 0784280074

─────────────────────
*BOT STATUS 👾*
> Bot Name : ${bN}
> Activers : ${activeSockets.size}
> Channel : ${followStatus}
─────────────────────

*╭─\`🎈 𝗠𝗔𝗜𝗡 𝗠𝗘𝗡𝗨 𝗖𝗔𝗧𝗘𝗚𝗢𝗥𝗜𝗘𝗦\`┤⭓*
*┃*
*┃ 1️⃣ - 📥 DOWNLOAD*
*┃ 2️⃣ - ⚙️ SETTINGS*
*┃ 3️⃣ - 👑 OWNER*
*┃ 4️⃣ - 🛠️ UTILITY*
*┃ 5️⃣ - 🤖 AI & CONVERT*
*┃ 6️⃣ - 👑 GROUP ADMIN*
*┃ 7️⃣ - 🎮 FUN*
*┃*
*╰──────────────────────*

💡 *Reply to this message with a number!*

> 🔗 Web: https://nimsara-official.vercel.app/
> *📢 CHANNEL :- ${BOT_CHANNEL_LINK}*

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

                // Mode
                case 'mode': {
                    if (!msg.key.fromMe && !isOwnerNumber(senderJid)) return reply(`⚠️ Only Owner!` + FOOTER);
                    const option = args[0]?.toLowerCase();
                    const valid = ['public', 'group', 'inbox', 'private'];
                    if (!valid.includes(option)) {
                        const cur = await get('BOT_MODE', number) || 'public';
                        return reply(`⚙️ *Mode*\nCurrent: *${cur.toUpperCase()}*\n\nOptions: public, group, inbox, private` + FOOTER);
                    }
                    await handleSettingUpdate("BOT_MODE", option, reply, number);
                    break;
                }

                // Autoread / Autoreply / others
                case 'autoread': {
                    if (!msg.key.fromMe && !isOwnerNumber(senderJid)) return reply(`⚠️ Only Owner!` + FOOTER);
                    const option = args[0]?.toLowerCase();
                    const valid = ['all', 'cmd', 'off'];
                    if (!valid.includes(option)) return reply(`👁️ *Auto-Read*\nCurrent: *${(global.autoReadStatus || 'off').toUpperCase()}*\n\nOptions: all, cmd, off` + FOOTER);
                    global.autoReadStatus = option;
                    await reply(`✅ Auto-Read: *${option.toUpperCase()}*` + FOOTER);
                    break;
                }

                case 'autoreply': {
                    if (!msg.key.fromMe && !isOwnerNumber(senderJid)) return reply(`⚠️ Only Owner!` + FOOTER);
                    const option = args[0]?.toLowerCase();
                    const valid = ['all', 'inbox', 'group', 'off'];
                    if (!valid.includes(option)) return reply(`🤖 *Auto-Reply*\nCurrent: *${(global.autoReplyMode || 'off').toUpperCase()}*\n\nOptions: all, inbox, group, off` + FOOTER);
                    global.autoReplyMode = option;
                    await reply(`✅ Auto-Reply: *${option.toUpperCase()}*` + FOOTER);
                    break;
                }

                case 'autoview': {
                    if (!msg.key.fromMe && !isOwnerNumber(senderJid)) return reply(`⚠️ Only Owner!` + FOOTER);
                    const val = args[0]?.toLowerCase();
                    if (!val || !['on', 'off'].includes(val)) return reply(`⚠️ Usage: .autoview on/off` + FOOTER);
                    await handleSettingUpdate("AUTO_VIEW_STATUS", val === 'on' ? 'true' : 'false', reply, number);
                    break;
                }

                case 'autolike': {
                    if (!msg.key.fromMe && !isOwnerNumber(senderJid)) return reply(`⚠️ Only Owner!` + FOOTER);
                    const val = args[0]?.toLowerCase();
                    if (!val || !['on', 'off'].includes(val)) return reply(`⚠️ Usage: .autolike on/off` + FOOTER);
                    await handleSettingUpdate("AUTO_LIKE_STATUS", val === 'on' ? 'true' : 'false', reply, number);
                    break;
                }

                case 'alwaysonline': {
                    if (!msg.key.fromMe && !isOwnerNumber(senderJid)) return reply(`⚠️ Only Owner!` + FOOTER);
                    const val = args[0]?.toLowerCase();
                    if (!val || !['on', 'off'].includes(val)) return reply(`⚠️ Usage: .alwaysonline on/off` + FOOTER);
                    await handleSettingUpdate("ALWAYS_ONLINE", val === 'on' ? 'true' : 'false', reply, number);
                    break;
                }

                case 'setprefix': {
                    if (!msg.key.fromMe && !isOwnerNumber(senderJid)) return reply(`⚠️ Only Owner!` + FOOTER);
                    const newPrefix = args[0];
                    if (!newPrefix) return reply(`⚠️ Usage: .setprefix [prefix]` + FOOTER);
                    await handleSettingUpdate("PREFIX", newPrefix, reply, number);
                    break;
                }

                case 'settings': {
                    const pfx = await get('PREFIX', number) || '.';
                    const bName = await get('BOT_NAME', number) || 'NIM BOT';
                    const autoView = await get('AUTO_VIEW_STATUS', number) ?? 'true';
                    const autoLike = await get('AUTO_LIKE_STATUS', number) ?? 'true';
                    const alwaysOnline = await get('ALWAYS_ONLINE', number) ?? 'true';
                    const autoSave = await get('AUTOSAVE_STATUS', number) || 'off';

                    await reply(`⚙️ *${bName} SETTINGS*\n\n> Bot Name: *${bName}*\n> Prefix: *${pfx}*\n> Auto View: *${autoView}*\n> Auto Like: *${autoLike}*\n> Always Online: *${alwaysOnline}*\n> AutoSave: *${autoSave}*` + FOOTER);
                    break;
                }

                // Nodelete
                case 'nodelet':
                case 'nodelete': {
                    const val = args[0]?.toLowerCase();
                    const targetChat = sender;
                    if (sender.endsWith('@g.us')) {
                        let isAdmin = msg.key.fromMe;
                        if (!isAdmin) {
                            try {
                                const meta = await socket.groupMetadata(sender);
                                const p = meta.participants.find(x => x.id === msg.key.participant);
                                isAdmin = p?.admin === 'admin' || p?.admin === 'superadmin';
                            } catch (e) {}
                        }
                        if (!isAdmin) return reply(`⚠️ Only admins!` + FOOTER);
                    } else if (!msg.key.fromMe && !isOwnerNumber(senderJid)) {
                        return reply(`⚠️ Only Owner!` + FOOTER);
                    }

                    let current = chatNodelete.get(targetChat);
                    if (!current) {
                        try { current = await get(`NODELETE_${targetChat}`, number); } catch (e) {}
                        current = current || 'off';
                        chatNodelete.set(targetChat, current);
                    }

                    if (!val || !['on', 'off'].includes(val)) {
                        return reply(`🗑️ *NODELETE*\nCurrent: *${current === 'on' ? '✅ ON' : '❌ OFF'}*\n\nUsage: .nodelet on/off` + FOOTER);
                    }

                    chatNodelete.set(targetChat, val);
                    try { await handleSettingUpdate(`NODELETE_${targetChat}`, val, reply, number); } catch (e) {}
                    await reply(`✅ *NODELETE ${val.toUpperCase()}*` + FOOTER);
                    break;
                }

                // Remsg
                case 'remsg':
                case 'delete': {
                    const last = deletedMessages.get(sender);
                    if (!last) return reply('❌ No deleted message!' + FOOTER);
                    const senderJid2 = last.sender;
                    const senderName = senderJid2.split('@')[0];
                    await reply({
                        text: `🗑️ *DELETED*\n\n👤 @${senderName}\n⏰ ${last.time}\n💬 ${last.text}` + FOOTER,
                        mentions: [senderJid2]
                    });
                    break;
                }

                // VVP
                case 'vvp':
                case 'viewoncept': {
                    const quoted = msg.message?.extendedTextMessage?.contextInfo;
                    if (!quoted?.quotedMessage) return reply(`⚠️ Reply to View Once media!` + FOOTER);

                    let qMsg = unwrapMessage(quoted.quotedMessage);
                    if (!qMsg) return reply(`⚠️ Could not read!` + FOOTER);

                    const mediaInfo = getMediaType(qMsg);
                    if (!mediaInfo || !['imageMessage', 'videoMessage'].includes(mediaInfo.type)) {
                        return reply(`⚠️ Reply to ViewOnce image/video!` + FOOTER);
                    }

                    const { type: messageType, data: mediaData } = mediaInfo;
                    const downloadMsg = {
                        key: { remoteJid: quoted.remoteJid || sender, id: quoted.stanzaId, participant: quoted.participant },
                        message: { [messageType]: mediaData }
                    };

                    try {
                        await reply(`⏳ Sending to owner...` + FOOTER);
                        const buffer = await downloadMediaMessage(downloadMsg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                        const ownerNumber = await getOwnerNumber(number);
                        const senderName = (msg.key.participant || sender).split('@')[0];
                        const ownerJid = `${ownerNumber}@s.whatsapp.net`;
                        const caption = `📥 *VIEW ONCE*\n\n👤 @${senderName}\n🕐 ${new Date().toLocaleString()}\n💬 ${mediaData?.caption || 'No caption'}` + FOOTER;

                        if (messageType === 'imageMessage') {
                            await socket.sendMessage(ownerJid, { image: buffer, caption, mentions: [msg.key.participant || sender], contextInfo: channelInfo });
                        } else {
                            await socket.sendMessage(ownerJid, { video: buffer, caption, mentions: [msg.key.participant || sender], contextInfo: channelInfo });
                        }

                        await reply(`✅ *Sent to Owner (+${ownerNumber})!*` + FOOTER);
                    } catch (err) {
                        await reply(`❌ ${err.message}` + FOOTER);
                    }
                    break;
                }

                // VV
                case 'vv':
                case 'viewonce': {
                    const quoted = msg.message?.extendedTextMessage?.contextInfo;
                    if (!quoted?.quotedMessage) return reply(`⚠️ Reply to ViewOnce media!` + FOOTER);

                    let qMsg = unwrapMessage(quoted.quotedMessage);
                    if (!qMsg) return reply(`⚠️ Could not read!` + FOOTER);

                    const mediaInfo = getMediaType(qMsg);
                    if (!mediaInfo || !['imageMessage', 'videoMessage'].includes(mediaInfo.type)) {
                        return reply(`⚠️ Reply to ViewOnce image/video!` + FOOTER);
                    }

                    const { type: messageType, data: mediaData } = mediaInfo;
                    const downloadMsg = {
                        key: { remoteJid: quoted.remoteJid || sender, id: quoted.stanzaId, participant: quoted.participant },
                        message: { [messageType]: mediaData }
                    };

                    try {
                        const buffer = await downloadMediaMessage(downloadMsg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                        const caption = `📥 *View Once*\n\n${mediaData?.caption || ''}` + FOOTER;
                        if (messageType === 'imageMessage') {
                            await socket.sendMessage(sender, { image: buffer, caption, contextInfo: channelInfo }, { quoted: msg });
                        } else {
                            await socket.sendMessage(sender, { video: buffer, caption, contextInfo: channelInfo }, { quoted: msg });
                        }
                    } catch (err) { await reply(`❌ ${err.message}` + FOOTER); }
                    break;
                }

                default:
                    break;
            }
        } catch (error) {
            console.error('Command error:', error);
        }
    });

    // Group Welcome/Goodbye
    socket.ev.on('group-participants.update', async (update) => {
        try {
            const { id, participants, action } = update;
            let welcomeEnabled = groupWelcome.get(id);
            if (!welcomeEnabled) {
                try { welcomeEnabled = await get(`WELCOME_${id}`, number); } catch (e) {}
                welcomeEnabled = welcomeEnabled || 'off';
                groupWelcome.set(id, welcomeEnabled);
            }
            if (welcomeEnabled !== 'on') return;

            const groupMeta = await socket.groupMetadata(id);
            const groupName = groupMeta.subject;

            for (const p of participants) {
                const userName = p.split('@')[0];
                if (action === 'add') {
                    await socket.sendMessage(id, {
                        image: { url: BOT_IMAGE_URL },
                        text: `🎉 *WELCOME* @${userName}!\n\n👋 Welcome to *${groupName}*` + FOOTER,
                        mentions: [p],
                        contextInfo: getChannelContext()
                    });
                } else if (action === 'remove') {
                    await socket.sendMessage(id, {
                        text: `👋 *GOODBYE* @${userName}!\n\n😢 We'll miss you!` + FOOTER,
                        mentions: [p],
                        contextInfo: getChannelContext()
                    });
                }
            }
        } catch (e) {}
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
            return ['ADMIN', 'OWNER', 'SUBSCRIBER'].includes(channelMeta.viewer_metadata.role);
        }
        return false;
    } catch (e) {
        return false;
    }
}

// ==========================================
// Status & Presence
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
            } catch (e) {}
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
        } catch (e) {}
    }, 60000);

    socket.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            if (!msg.message) continue;
            const botNum = getBotNumber();

            if (msg.key && msg.key.remoteJid === 'status@broadcast') {
                const autoView = await get('AUTO_VIEW_STATUS', botNum);
                if (autoView !== 'false' && autoView !== 'off') {
                    try { await socket.readMessages([msg.key]); } catch (e) {}
                }

                const autoLike = await get('AUTO_LIKE_STATUS', botNum);
                if (autoLike === 'true' || autoLike === 'on') {
                    try {
                        const emojis = ['❤️', '🔦', '👌', '✨', '🤍', '🌝'];
                        await socket.sendMessage('status@broadcast', {
                            react: { text: emojis[Math.floor(Math.random() * emojis.length)], key: msg.key }
                        }, { statusJidList: [msg.key.participant] });
                    } catch (e) {}
                }
            }
        }
    });
}

// ==========================================
// Restore Sessions
// ==========================================
async function restoreExistingSessions() {
    try {
        const allSessions = await Session.find({});
        if (allSessions.length === 0) return;
        console.log(`📋 Restoring ${allSessions.length} sessions...`);
        for (const session of allSessions) {
            if (session.number && session.creds && Object.keys(session.creds).length > 0) {
                try {
                    if (activeSockets.has(session.number)) continue;
                    await StartBot(session.number, null, true);
                    await delay(2000);
                } catch (e) {}
            }
        }
    } catch (e) {}
}

// ==========================================
// Start Bot
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
                const botName = await get('BOT_NAME', botNumber) || 'NIM BOT';
                const currentPrefix = await get('PREFIX', botNumber) || '.';
                const ownJid = `${botNumber}@s.whatsapp.net`;

                await currentSock.sendMessage(ownJid, {
                    image: { url: BOT_IMAGE_URL },
                    caption: `🎉 *${botName} CONNECTED* 🎉\n\n✅ Bot is online!\n\n• Name: *${botName}*\n• Number: *${botNumber}*\n• Prefix: *${currentPrefix}*\n\nType *${currentPrefix}menu*\n\n> © ᴄʀᴇᴀᴛᴏʀ ʙY ɴɪᴍꜱᴀʀᴀ 🥷🏻`,
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
                connectMessageSent = false;
            }
        };

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'open') {
                console.log(`✅ Connected: ${sanitizedNumber}`);
                reconnectAttempts.set(sanitizedNumber, 0);
                try { if (typeof ensureConfig === 'function') await ensureConfig(sanitizedNumber); } catch (err) {}
                socketCreationTime.set(sanitizedNumber, Date.now());
                activeSockets.set(sanitizedNumber, sock);
                setTimeout(() => sendConnectMessage(sock, sanitizedNumber), 3000);

                if (res && typeof res.send === 'function' && !res.headersSent) {
                    return res.send({ status: "Connected", number: sanitizedNumber });
                }
            } else if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
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
                if (res && typeof res.send === 'function' && !res.headersSent) res.send({ code });
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
    if (!number) return res.status(400).send({ error: 'Phone required!' });
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    try {
        if (activeSockets.has(sanitizedNumber)) {
            const sock = activeSockets.get(sanitizedNumber);
            try { await sock.logout(); await sock.end(); } catch (e) {}
            activeSockets.delete(sanitizedNumber);
        }
        await Session.deleteOne({ number: sanitizedNumber });
        await fs.remove(path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`));
        res.send({ status: "Logged out" });
    } catch (e) { res.status(500).send({ error: e.message }); }
});

router.get('/sessions', async (req, res) => {
    try {
        const allSessions = await Session.find({});
        const active = Array.from(activeSockets.keys());
        res.send({ total: allSessions.length, active, sessions: allSessions.map(s => ({ number: s.number, isActive: active.includes(s.number) })) });
    } catch (e) { res.status(500).send({ error: e.message }); }
});

router.post('/reconnect', async (req, res) => {
    const { number } = req.body || req.query;
    if (!number) return res.status(400).send({ error: 'Phone required!' });
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    try {
        if (activeSockets.has(sanitizedNumber)) return res.send({ status: "Already connected" });
        await StartBot(sanitizedNumber, null, true);
        res.send({ status: "Reconnect initiated" });
    } catch (e) { res.status(500).send({ error: e.message }); }
});

router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) return res.status(400).send({ error: 'Phone required!' });
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
    try { await delay(5000); await restoreExistingSessions(); } catch (e) {}
})();

module.exports = router;
