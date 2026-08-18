const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '/')));

const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://nimsaranethmintha_db_user:gH1jI6l0skaYDyUh@cluster0.lwkgsqx.mongodb.net/?appName=Cluster0";

mongoose.connect(MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => {
    console.log("📦 Connected to MongoDB successfully!");
}).catch((err) => {
    console.error("❌ MongoDB connection error:", err);
});

const pairRouter = require('./pair');
app.use('/pair', pairRouter);

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'main.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 NIM BOT Server is running on port ${PORT}`);
});

module.exports = app;
