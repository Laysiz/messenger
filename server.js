require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Создаем папку для загрузок
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

// Настройка multer для загрузки файлов
const storage = multer.diskStorage({
    destination: 'uploads/',
    filename: (req, file, cb) => {
        const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
        cb(null, uniqueName);
    }
});
const upload = multer({ storage: storage, limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB

// Инициализация базы данных
const db = new sqlite3.Database('database.sqlite');

// Создание таблиц
db.serialize(() => {
    // Пользователи
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        avatar TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Комнаты
    db.run(`CREATE TABLE IF NOT EXISTS rooms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        created_by INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Сообщения
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id INTEGER,
        user_id INTEGER,
        username TEXT,
        message TEXT,
        file_url TEXT,
        file_type TEXT,
        is_private BOOLEAN DEFAULT 0,
        private_to INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Участники комнат
    db.run(`CREATE TABLE IF NOT EXISTS room_members (
        room_id INTEGER,
        user_id INTEGER,
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Создаем комнаты по умолчанию
    const defaultRooms = ['Общий', 'Случайные темы', 'Помощь', 'Игры'];
    defaultRooms.forEach(room => {
        db.run(`INSERT OR IGNORE INTO rooms (name, created_by) VALUES (?, 1)`, [room]);
    });
});

// Хранилище активных WebSocket соединений
const clients = new Map(); // key: userId, value: ws
const roomConnections = new Map(); // key: roomId, value: Set of userIds

// Middleware для аутентификации JWT
function authenticateToken(req, res, next) {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid token' });
        req.user = user;
        next();
    });
}

// API endpoints

// Регистрация
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    
    const hashedPassword = await bcrypt.hash(password, 10);
    
    db.run(`INSERT INTO users (username, password) VALUES (?, ?)`, [username, hashedPassword], function(err) {
        if (err) return res.status(400).json({ error: 'Username already exists' });
        
        const token = jwt.sign({ id: this.lastID, username }, process.env.JWT_SECRET);
        res.json({ token, userId: this.lastID, username });
    });
});

// Логин
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    
    db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
        if (err || !user) return res.status(400).json({ error: 'User not found' });
        
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.status(400).json({ error: 'Invalid password' });
        
        const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET);
        res.json({ token, userId: user.id, username: user.username });
    });
});

// Получение комнат
app.get('/api/rooms', authenticateToken, (req, res) => {
    db.all(`SELECT * FROM rooms`, (err, rooms) => {
        res.json(rooms);
    });
});

// Создание комнаты
app.post('/api/rooms', authenticateToken, (req, res) => {
    const { name } = req.body;
    db.run(`INSERT INTO rooms (name, created_by) VALUES (?, ?)`, [name, req.user.id], function(err) {
        if (err) return res.status(400).json({ error: 'Room name exists' });
        res.json({ id: this.lastID, name });
    });
});

// Загрузка файла
app.post('/api/upload', authenticateToken, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    
    const fileUrl = `/uploads/${req.file.filename}`;
    const fileType = req.file.mimetype.startsWith('image/') ? 'image' : 'file';
    
    res.json({ fileUrl, fileType, originalName: req.file.originalname });
});

// Получение истории сообщений комнаты
app.get('/api/messages/:roomId', authenticateToken, (req, res) => {
    const { roomId } = req.params;
    const { limit = 100 } = req.query;
    
    db.all(`SELECT * FROM messages WHERE room_id = ? AND is_private = 0 ORDER BY created_at DESC LIMIT ?`,
        [roomId, limit], (err, messages) => {
        res.json(messages.reverse());
    });
});

// WebSocket обработка
wss.on('connection', (ws, req) => {
    let currentUser = null;
    let currentRoom = 1; // Общая комната по умолчанию
    
    ws.on('message', async (data) => {
        try {
            const parsed = JSON.parse(data);
            
            switch(parsed.type) {
                case 'auth':
                    // Аутентификация через WebSocket
                    const token = parsed.token;
                    const decoded = jwt.verify(token, process.env.JWT_SECRET);
                    currentUser = { id: decoded.id, username: decoded.username };
                    clients.set(currentUser.id, ws);
                    
                    // Отправляем список активных пользователей
                    const onlineUsers = Array.from(clients.keys());
                    ws.send(JSON.stringify({ type: 'online_users', users: onlineUsers }));
                    
                    // Рассылаем всем обновленный список
                    broadcastToRoom(currentRoom, {
                        type: 'user_joined',
                        username: currentUser.username,
                        onlineCount: clients.size
                    });
                    break;
                    
                case 'join_room':
                    currentRoom = parsed.roomId;
                    if (!roomConnections.has(currentRoom)) {
                        roomConnections.set(currentRoom, new Set());
                    }
                    roomConnections.get(currentRoom).add(currentUser.id);
                    
                    // Отправляем историю комнаты
                    db.all(`SELECT * FROM messages WHERE room_id = ? AND is_private = 0 ORDER BY created_at ASC LIMIT 100`,
                        [currentRoom], (err, messages) => {
                        ws.send(JSON.stringify({ type: 'history', messages }));
                    });
                    break;
                    
                case 'message':
                    const { message, roomId, isPrivate, privateTo } = parsed;
                    
                    // Сохраняем в БД
                    db.run(`INSERT INTO messages (room_id, user_id, username, message, is_private, private_to)
                            VALUES (?, ?, ?, ?, ?, ?)`,
                        [roomId || currentRoom, currentUser.id, currentUser.username, message, isPrivate || 0, privateTo || null]);
                    
                    const messageData = {
                        type: 'message',
                        id: Date.now(),
                        username: currentUser.username,
                        message: message,
                        timestamp: new Date().toISOString(),
                        userId: currentUser.id
                    };
                    
                    if (isPrivate && privateTo) {
                        // Личное сообщение
                        const targetWs = clients.get(privateTo);
                        if (targetWs) {
                            targetWs.send(JSON.stringify({ ...messageData, isPrivate: true, from: currentUser.username }));
                        }
                        ws.send(JSON.stringify({ ...messageData, isPrivate: true, to: privateTo, sent: true }));
                    } else {
                        // Публичное сообщение в комнату
                        broadcastToRoom(roomId || currentRoom, messageData);
                    }
                    break;
                    
                case 'file':
                    const { fileUrl, fileType, originalName, roomId } = parsed;
                    
                    db.run(`INSERT INTO messages (room_id, user_id, username, message, file_url, file_type)
                            VALUES (?, ?, ?, ?, ?, ?)`,
                        [roomId || currentRoom, currentUser.id, currentUser.username, originalName, fileUrl, fileType]);
                    
                    broadcastToRoom(roomId || currentRoom, {
                        type: 'file',
                        username: currentUser.username,
                        fileUrl: fileUrl,
                        fileType: fileType,
                        originalName: originalName,
                        timestamp: new Date().toISOString()
                    });
                    break;
                    
                case 'typing':
                    broadcastToRoom(currentRoom, {
                        type: 'typing',
                        username: currentUser.username,
                        isTyping: parsed.isTyping
                    });
                    break;
            }
        } catch(e) {
            console.error('WebSocket error:', e);
        }
    });
    
    ws.on('close', () => {
        if (currentUser) {
            clients.delete(currentUser.id);
            broadcastToRoom(currentRoom, {
                type: 'user_left',
                username: currentUser.username,
                onlineCount: clients.size
            });
        }
    });
});

// Функция широковещательной рассылки в комнату
function broadcastToRoom(roomId, data) {
    const roomUsers = roomConnections.get(roomId);
    if (!roomUsers) return;
    
    roomUsers.forEach(userId => {
        const client = clients.get(userId);
        if (client && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✅ Сервер запущен на http://localhost:${PORT}`);
});