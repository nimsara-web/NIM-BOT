module.exports = {
    parseMessage: (msg) => {
        if (!msg.message) return "";
        return msg.message.conversation || 
               msg.message.extendedTextMessage?.text || 
               msg.message.imageMessage?.caption || "";
    }
};
