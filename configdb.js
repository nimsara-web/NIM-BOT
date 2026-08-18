/**
 * Project: NIM BOT - Config Database Module
 * Creator: Nimsara
 */

const mongoose = require('mongoose');

const configSchema = new mongoose.Schema({
    number: { type: String, required: true, unique: true },
    settings: { type: Map, of: String, default: {} },
    updatedAt: { type: Date, default: Date.now }
});

const Config = mongoose.models.Config || mongoose.model('Config', configSchema);

async function ensureConfig(number) {
    if (!number) return;
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    let doc = await Config.findOne({ number: sanitizedNumber });
    if (!doc) {
        doc = new Config({
            number: sanitizedNumber,
            settings: new Map([
                ['PREFIX', '.'],
                ['BOT_NAME', 'NIM BOT'],
                ['AUTO_VIEW_STATUS', 'true'],
                ['AUTO_LIKE_STATUS', 'true']
            ])
        });
        await doc.save();
    }
    return doc;
}

async function get(key, number) {
    if (!number) return null;
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const doc = await Config.findOne({ number: sanitizedNumber });
    if (doc && doc.settings && doc.settings.has(key)) {
        return doc.settings.get(key);
    }
    const defaults = {
        PREFIX: '.',
        BOT_NAME: 'NIM BOT',
        AUTO_VIEW_STATUS: 'true',
        AUTO_LIKE_STATUS: 'true'
    };
    return defaults[key] || null;
}

async function input(key, value, number) {
    if (!number) return;
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    let doc = await Config.findOne({ number: sanitizedNumber });
    if (!doc) {
        doc = new Config({ number: sanitizedNumber, settings: new Map() });
    }
    doc.settings.set(key, value);
    doc.updatedAt = new Date();
    await doc.save();
    return true;
}

async function handleSettingUpdate(key, value, reply, number) {
    await input(key, value, number);
    await reply(`✅ Successfully updated *${key}* to: *${value}*`);
}

module.exports = {
    get,
    input,
    ensureConfig,
    handleSettingUpdate
};
