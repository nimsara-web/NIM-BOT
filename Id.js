const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema({
    number: { type: String, required: true, unique: true },
    creds: { type: Object, required: true },
    keys: { type: Object, default: {} },
    updatedAt: { type: Date, default: Date.now }
});

const Session = mongoose.model('Session', sessionSchema);
module.exports = Session;
