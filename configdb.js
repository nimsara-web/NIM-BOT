const mongoose = require('mongoose');

const configSchema = new mongoose.Schema({
    number: { type: String, required: true },
    settings: { type: Object, default: {} }
});

const ConfigModel = mongoose.model('BotConfig', configSchema);

async function get(key, number) {
    try {
        const doc = await ConfigModel.findOne({ number });
        if (!doc) return null;
        return doc.settings[key];
    } catch (e) {
        console.error("Config get error:", e);
        return null;
    }
}

async function input(key, value, number) {
    try {
        let doc = await ConfigModel.findOne({ number });
        if (!doc) {
            doc = new ConfigModel({ number, settings: {} });
        }
        doc.settings[key] = value;
        await doc.save();
    } catch (e) {
        console.error("Config input error:", e);
    }
}

async function ensureConfig(number) {
    try {
        let doc = await ConfigModel.findOne({ number });
        if (!doc) {
            await ConfigModel.create({
                number,
                settings: {
                    BOT_NAME: "NIM BOT",
                    PREFIX: ".",
                    AUTO_VIEW_STATUS: "true",
                    AUTO_LIKE_STATUS: "true",
                    ALWAYS_ONLINE: "false",
                    ANTI_DELETE: "false",
                    AUTO_REPLY: "true"
                }
            });
        }
    } catch (e) {
        console.error("Ensure config error:", e);
    }
}

async function handleSettingUpdate(key, value, reply, number) {
    await input(key, value, number);
    await reply(`✅ Setting *${key}* successfully updated to: *${value}*`);
}

module.exports = { get, input, ensureConfig, handleSettingUpdate };
