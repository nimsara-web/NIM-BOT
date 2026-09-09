const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema({
    number: { 
        type: String, 
        required: true, 
        unique: true,
        index: true
    },
    creds: { 
        type: Object, 
        required: true,
        default: {}
    },
    keys: { 
        type: Object, 
        default: {} 
    },
    lastSeen: { 
        type: Date, 
        default: Date.now 
    },
    createdAt: { 
        type: Date, 
        default: Date.now 
    },
    updatedAt: { 
        type: Date, 
        default: Date.now 
    },
    isActive: {
        type: Boolean,
        default: false
    },
    deviceInfo: {
        type: Object,
        default: {}
    }
});

// Indexes for better performance
sessionSchema.index({ number: 1 });
sessionSchema.index({ lastSeen: -1 });
sessionSchema.index({ updatedAt: -1 });

// Update timestamps on save
sessionSchema.pre('save', function(next) {
    this.updatedAt = new Date();
    next();
});

// Update timestamps on findOneAndUpdate
sessionSchema.pre('findOneAndUpdate', function(next) {
    this.set({ updatedAt: new Date() });
    next();
});

// Method to check if session is expired (30 days)
sessionSchema.methods.isExpired = function() {
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    return (Date.now() - this.updatedAt.getTime()) > thirtyDays;
};

// Static method to find active sessions
sessionSchema.statics.findActiveSessions = function() {
    return this.find({ isActive: true });
};

// Static method to find expired sessions
sessionSchema.statics.findExpiredSessions = function() {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    return this.find({ updatedAt: { $lt: thirtyDaysAgo } });
};

// Static method to cleanup expired sessions
sessionSchema.statics.cleanupExpiredSessions = async function() {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const result = await this.deleteMany({ 
        updatedAt: { $lt: thirtyDaysAgo },
        isActive: false 
    });
    return result;
};

const Session = mongoose.model('Session', sessionSchema);

module.exports = Session;
