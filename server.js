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

app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

const storage = multer.diskStorage({
    destination: 'uploads/',
    filename: (req, file, cb) => {
        const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
        cb(null, uniqueName);
    }
});
const upload = multer({ storage: storage, limits: { fileSize: 10 * 1024 * 1024 } });

const db = new sqlite3.Database('database.sqlite');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        avatar TEXT,
        online BOOLEAN DEFAULT 0,
        last_seen DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS friends (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        friend_id INTEGER,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id),
        FOREIGN KEY(friend_id) REFERENCES users(id),
        UNIQUE(user_id, friend_id)
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS rooms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        type TEXT DEFAULT 'public',
        created_by INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS room_members (
        room_id INTEGER,
        user_id INTEGER,
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(room_id) REFERENCES rooms(id),
        FOREIGN KEY(user_id) REFERENCES users(id),
        UNIQUE(room_id, user_id)
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id INTEGER,
        user_id INTEGER,
        username TEXT,
        message TEXT,
        file_url TEXT,
        file_type TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`INSERT OR IGNORE INTO rooms (id, name, type, created_by) VALUES (1, 'Общий чат', 'public', 1)`);
});

const clients = new Map();
const roomConnections = new Map();

function authenticateToken(req, res, next) {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid token' });
        req.user = user;
        next();
    });
}

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

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    
    db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
        if (err || !user) return res.status(400).json({ error: 'User not found' });
        
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.status(400).json({ error: 'Invalid password' });
        
        db.run(`UPDATE users SET online = 1, last_seen = CURRENT_TIMESTAMP WHERE id = ?`, [user.id]);
        
        const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET);
        res.json({ token, userId: user.id, username: user.username });
    });
});

app.get('/api/users/search', authenticateToken, (req, res) => {
    const { q } = req.query;
    db.all(`SELECT id, username FROM users WHERE username LIKE ? AND id != ? LIMIT 10`, 
        [`%${q}%`, req.user.id], (err, users) => {
        res.json(users);
    });
});

app.get('/api/friends', authenticateToken, (req, res) => {
    db.all(`
        SELECT u.id, u.username, u.online, f.status 
        FROM friends f
        JOIN users u ON (u.id = f.friend_id OR u.id = f.user_id)
        WHERE (f.user_id = ? OR f.friend_id = ?) 
        AND u.id != ?
        AND f.status = 'accepted'
    `, [req.user.id, req.user.id, req.user.id], (err, friends) => {
        res.json(friends);
    });
});

app.post('/api/friends/add', authenticateToken, (req, res) => {
    const { friendUsername } = req.body;
    
    db.get(`SELECT id FROM users WHERE username = ?`, [friendUsername], (err, user) => {
        if (err || !user) return res.status(404).json({ error: 'User not found' });
        if (user.id === req.user.id) return res.status(400).json({ error: 'Cannot add yourself' });
        
        db.run(`INSERT OR IGNORE INTO friends (user_id, friend_id, status) VALUES (?, ?, 'pending')`,
            [req.user.id, user.id], function(err) {
            if (err) return res.status(400).json({ error: 'Friend request already sent' });
            res.json({ success: true, message: 'Friend request sent' });
        });
    });
});

app.get('/api/rooms', authenticateToken, (req, res) => {
    db.all(`
        SELECT DISTINCT r.* FROM rooms r
        LEFT JOIN room_members rm ON rm.room_id = r.id
        WHERE rm.user_id = ? OR r.type = 'public'
        ORDER BY r.created_at DESC
    `, [req.user.id], (err, rooms) => {
        res.json(rooms);
    });
});

app.post('/api/rooms/private', authenticateToken, (req, res) => {
    const { name, members } = req.body;
    
    db.run(`INSERT INTO rooms (name, type, created_by) VALUES (?, 'private', ?)`,
        [name, req.user.id], function(err) {
        if (err) return res.status(400).json({ error: 'Error creating room' });
        
        const roomId = this.lastID;
        db.run(`INSERT INTO room_members (room_id, user_id) VALUES (?, ?)`, [roomId, req.user.id]);
        
        members.forEach(memberId => {
            db.run(`INSERT INTO room_members (room_id, user_id) VALUES (?, ?)`, [roomId, memberId]);
        });
        
        res.json({ id: roomId, name, type: 'private' });
    });
});

app.post('/api/rooms/direct', authenticateToken, (req, res) => {
    const { friendId } = req.body;
    
    db.get(`
        SELECT r.id FROM rooms r
        JOIN room_members rm1 ON rm1.room_id = r.id AND rm1.user_id = ?
        JOIN room_members rm2 ON rm2.room_id = r.id AND rm2.user_id = ?
        WHERE r.type = 'direct'
    `, [req.user.id, friendId], (err, existing) => {
        if (existing) {
            return res.json({ id: existing.id, name: 'Личный чат', type: 'direct', existing: true });
        }
        
        db.run(`INSERT INTO rooms (name, type, created_by) VALUES (?, 'direct', ?)`,
            ['Личный чат', req.user.id], function(err) {
            if (err) return res.status(400).json({ error: 'Error creating direct chat' });
            
            const roomId = this.lastID;
            db.run(`INSERT INTO room_members (room_id, user_id) VALUES (?, ?)`, [roomId, req.user.id]);
            db.run(`INSERT INTO room_members (room_id, user_id) VALUES (?, ?)`, [roomId, friendId]);
            
            res.json({ id: roomId, name: 'Личный чат', type: 'direct' });
        });
    });
});

app.get('/api/messages/:roomId', authenticateToken, (req, res) => {
    const { roomId } = req.params;
    const { limit = 100 } = req.query;
    
    db.all(`SELECT * FROM messages WHERE room_id = ? ORDER BY created_at DESC LIMIT ?`,
        [roomId, limit], (err, messages) => {
        res.json(messages.reverse());
    });
});

app.post('/api/upload', authenticateToken, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    
    const fileUrl = `/uploads/${req.file.filename}`;
    const fileType = req.file.mimetype.startsWith('image/') ? 'image' : 'file';
    
    res.json({ fileUrl, fileType, originalName: req.file.originalname });
});

// WebSocket обработка - ИСПРАВЛЕНА!
wss.on('connection', (ws) => {
    let currentUser = null;
    let currentRoom = 1;
    
    ws.on('message', async (data) => {
        try {
            const parsed = JSON.parse(data);
            
            switch(parsed.type) {
                case 'auth': {
                    const decoded = jwt.verify(parsed.token, process.env.JWT_SECRET);
                    currentUser = { id: decoded.id, username: decoded.username };
                    clients.set(currentUser.id, ws);
                    
                    db.run(`UPDATE users SET online = 1, last_seen = CURRENT_TIMESTAMP WHERE id = ?`, [currentUser.id]);
                    
                    db.all(`
                        SELECT DISTINCT r.* FROM rooms r
                        LEFT JOIN room_members rm ON rm.room_id = r.id
                        WHERE rm.user_id = ? OR r.type = 'public'
                    `, [currentUser.id], (err, rooms) => {
                        ws.send(JSON.stringify({ type: 'rooms_list', rooms }));
                    });
                    
                    db.all(`
                        SELECT u.id, u.username, u.online 
                        FROM friends f
                        JOIN users u ON (u.id = f.friend_id OR u.id = f.user_id)
                        WHERE (f.user_id = ? OR f.friend_id = ?) AND u.id != ? AND f.status = 'accepted'
                    `, [currentUser.id, currentUser.id, currentUser.id], (err, friends) => {
                        ws.send(JSON.stringify({ type: 'friends_list', friends }));
                    });
                    break;
                }
                    
                case 'join_room': {
                    currentRoom = parsed.roomId;
                    if (!roomConnections.has(currentRoom)) {
                        roomConnections.set(currentRoom, new Set());
                    }
                    roomConnections.get(currentRoom).add(currentUser.id);
                    
                    db.all(`SELECT * FROM messages WHERE room_id = ? ORDER BY created_at ASC LIMIT 100`,
                        [currentRoom], (err, messages) => {
                        ws.send(JSON.stringify({ type: 'history', messages }));
                    });
                    break;
                }
                    
                case 'message': {
                    const { message, roomId } = parsed;
                    const targetRoom = roomId || currentRoom;
                    
                    db.run(`INSERT INTO messages (room_id, user_id, username, message) VALUES (?, ?, ?, ?)`,
                        [targetRoom, currentUser.id, currentUser.username, message]);
                    
                    const messageData = {
                        type: 'message',
                        id: Date.now(),
                        username: currentUser.username,
                        userId: currentUser.id,
                        message: message,
                        timestamp: new Date().toISOString()
                    };
                    
                    broadcastToRoom(targetRoom, messageData);
                    break;
                }
                    
                case 'file': {
                    const { fileUrl, fileType, originalName, roomId } = parsed;
                    const targetRoomFile = roomId || currentRoom;
                    
                    db.run(`INSERT INTO messages (room_id, user_id, username, message, file_url, file_type) VALUES (?, ?, ?, ?, ?, ?)`,
                        [targetRoomFile, currentUser.id, currentUser.username, originalName, fileUrl, fileType]);
                    
                    broadcastToRoom(targetRoomFile, {
                        type: 'file',
                        username: currentUser.username,
                        fileUrl: fileUrl,
                        fileType: fileType,
                        originalName: originalName,
                        timestamp: new Date().toISOString()
                    });
                    break;
                }
                    
                case 'typing': {
                    broadcastToRoom(currentRoom, {
                        type: 'typing',
                        username: currentUser.username,
                        isTyping: parsed.isTyping
                    });
                    break;
                }
            }
        } catch(e) {
            console.error('WebSocket error:', e);
        }
    });
    
    ws.on('close', () => {
        if (currentUser) {
            clients.delete(currentUser.id);
            db.run(`UPDATE users SET online = 0, last_seen = CURRENT_TIMESTAMP WHERE id = ?`, [currentUser.id]);
            
            broadcastToRoom(currentRoom, {
                type: 'user_left',
                username: currentUser.username
            });
        }
    });
});

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