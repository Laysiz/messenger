require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Pool } = require('pg');
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

// Настройка PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const storage = multer.diskStorage({
    destination: 'uploads/',
    filename: (req, file, cb) => {
        const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
        cb(null, uniqueName);
    }
});
const upload = multer({ storage: storage, limits: { fileSize: 10 * 1024 * 1024 } });

// Создание таблиц
async function initDatabase() {
    const client = await pool.connect();
    try {
        // Пользователи
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                avatar TEXT,
                online BOOLEAN DEFAULT false,
                last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Друзья
        await client.query(`
            CREATE TABLE IF NOT EXISTS friends (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                friend_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                status TEXT DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, friend_id)
            )
        `);
        
        // Комнаты
        await client.query(`
            CREATE TABLE IF NOT EXISTS rooms (
                id SERIAL PRIMARY KEY,
                name TEXT,
                type TEXT DEFAULT 'public',
                created_by INTEGER REFERENCES users(id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Участники комнат
        await client.query(`
            CREATE TABLE IF NOT EXISTS room_members (
                room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(room_id, user_id)
            )
        `);
        
        // Сообщения
        await client.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                username TEXT,
                message TEXT,
                file_url TEXT,
                file_type TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Создаем общий чат если его нет
        const roomCheck = await client.query(`SELECT id FROM rooms WHERE id = 1`);
        if (roomCheck.rows.length === 0) {
            await client.query(`INSERT INTO rooms (id, name, type, created_by) VALUES (1, 'Общий чат', 'public', 1)`);
        }
        
        console.log('✅ База данных инициализирована');
    } catch (err) {
        console.error('Database init error:', err);
    } finally {
        client.release();
    }
}

initDatabase();

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

// API Endpoints
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await pool.query(
            `INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id, username`,
            [username, hashedPassword]
        );
        const user = result.rows[0];
        const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET);
        res.json({ token, userId: user.id, username: user.username });
    } catch (err) {
        if (err.code === '23505') {
            res.status(400).json({ error: 'Username already exists' });
        } else {
            res.status(500).json({ error: 'Registration failed' });
        }
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query(`SELECT * FROM users WHERE username = $1`, [username]);
        if (result.rows.length === 0) {
            return res.status(400).json({ error: 'User not found' });
        }
        const user = result.rows[0];
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.status(400).json({ error: 'Invalid password' });
        
        await pool.query(`UPDATE users SET online = true, last_seen = CURRENT_TIMESTAMP WHERE id = $1`, [user.id]);
        
        const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET);
        res.json({ token, userId: user.id, username: user.username });
    } catch (err) {
        res.status(500).json({ error: 'Login failed' });
    }
});

app.get('/api/users/search', authenticateToken, async (req, res) => {
    const { q } = req.query;
    try {
        const result = await pool.query(
            `SELECT id, username FROM users WHERE username LIKE $1 AND id != $2 LIMIT 10`,
            [`%${q}%`, req.user.id]
        );
        res.json(result.rows);
    } catch (err) {
        res.json([]);
    }
});

app.get('/api/friends/requests', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT u.id, u.username, u.online, f.id as request_id
            FROM friends f
            JOIN users u ON u.id = f.user_id
            WHERE f.friend_id = $1 AND f.status = 'pending'
        `, [req.user.id]);
        res.json(result.rows);
    } catch (err) {
        res.json([]);
    }
});

app.get('/api/friends', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT DISTINCT u.id, u.username, u.online, f.status 
            FROM friends f
            JOIN users u ON (u.id = f.friend_id OR u.id = f.user_id)
            WHERE (f.user_id = $1 OR f.friend_id = $1) 
            AND u.id != $1
            AND f.status = 'accepted'
        `, [req.user.id]);
        res.json(result.rows);
    } catch (err) {
        res.json([]);
    }
});

app.post('/api/friends/add', authenticateToken, async (req, res) => {
    const { friendUsername } = req.body;
    try {
        const userResult = await pool.query(`SELECT id FROM users WHERE username = $1`, [friendUsername]);
        if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        const friendId = userResult.rows[0].id;
        if (friendId === req.user.id) return res.status(400).json({ error: 'Cannot add yourself' });
        
        const existing = await pool.query(
            `SELECT * FROM friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)`,
            [req.user.id, friendId]
        );
        if (existing.rows.length > 0) {
            if (existing.rows[0].status === 'pending') return res.status(400).json({ error: 'Friend request already sent' });
            if (existing.rows[0].status === 'accepted') return res.status(400).json({ error: 'Already friends' });
        }
        
        await pool.query(
            `INSERT INTO friends (user_id, friend_id, status) VALUES ($1, $2, 'pending')`,
            [req.user.id, friendId]
        );
        
        const targetSocket = clients.get(friendId);
        if (targetSocket && targetSocket.readyState === WebSocket.OPEN) {
            targetSocket.send(JSON.stringify({
                type: 'friend_request',
                from: { id: req.user.id, username: req.user.username }
            }));
        }
        res.json({ success: true, message: 'Friend request sent' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to send friend request' });
    }
});

app.post('/api/friends/accept', authenticateToken, async (req, res) => {
    const { requestId } = req.body;
    try {
        const result = await pool.query(
            `UPDATE friends SET status = 'accepted' WHERE id = $1 AND friend_id = $2 RETURNING user_id`,
            [requestId, req.user.id]
        );
        if (result.rows.length === 0) return res.status(400).json({ error: 'Failed to accept request' });
        
        const friendResult = await pool.query(
            `SELECT u.id, u.username FROM friends f JOIN users u ON u.id = f.user_id WHERE f.id = $1`,
            [requestId]
        );
        if (friendResult.rows.length > 0) {
            const senderSocket = clients.get(friendResult.rows[0].id);
            if (senderSocket && senderSocket.readyState === WebSocket.OPEN) {
                senderSocket.send(JSON.stringify({
                    type: 'friend_accepted',
                    by: { id: req.user.id, username: req.user.username }
                }));
            }
        }
        res.json({ success: true, message: 'Friend request accepted' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to accept' });
    }
});

app.post('/api/friends/reject', authenticateToken, async (req, res) => {
    const { requestId } = req.body;
    try {
        await pool.query(`DELETE FROM friends WHERE id = $1 AND friend_id = $2`, [requestId, req.user.id]);
        res.json({ success: true, message: 'Friend request rejected' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to reject' });
    }
});

app.get('/api/rooms', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT DISTINCT r.* FROM rooms r
            LEFT JOIN room_members rm ON rm.room_id = r.id
            WHERE rm.user_id = $1 OR r.type = 'public'
            ORDER BY r.created_at DESC
        `, [req.user.id]);
        
        const enrichedRooms = [];
        for (const room of result.rows) {
            if (room.type === 'direct') {
                const otherMember = await pool.query(`
                    SELECT u.username FROM room_members rm
                    JOIN users u ON u.id = rm.user_id
                    WHERE rm.room_id = $1 AND rm.user_id != $2
                `, [room.id, req.user.id]);
                enrichedRooms.push({
                    ...room,
                    displayName: otherMember.rows[0]?.username || room.name
                });
            } else {
                enrichedRooms.push({ ...room, displayName: room.name });
            }
        }
        res.json(enrichedRooms);
    } catch (err) {
        res.json([]);
    }
});

app.post('/api/rooms/private', authenticateToken, async (req, res) => {
    const { name, members } = req.body;
    try {
        const roomResult = await pool.query(
            `INSERT INTO rooms (name, type, created_by) VALUES ($1, 'private', $2) RETURNING id`,
            [name, req.user.id]
        );
        const roomId = roomResult.rows[0].id;
        
        await pool.query(`INSERT INTO room_members (room_id, user_id) VALUES ($1, $2)`, [roomId, req.user.id]);
        for (const memberId of members) {
            await pool.query(`INSERT INTO room_members (room_id, user_id) VALUES ($1, $2)`, [roomId, memberId]);
        }
        res.json({ id: roomId, name, type: 'private' });
    } catch (err) {
        res.status(500).json({ error: 'Error creating room' });
    }
});

app.post('/api/rooms/direct', authenticateToken, async (req, res) => {
    const { friendId } = req.body;
    try {
        const existing = await pool.query(`
            SELECT r.id, r.name FROM rooms r
            JOIN room_members rm1 ON rm1.room_id = r.id AND rm1.user_id = $1
            JOIN room_members rm2 ON rm2.room_id = r.id AND rm2.user_id = $2
            WHERE r.type = 'direct'
        `, [req.user.id, friendId]);
        
        if (existing.rows.length > 0) {
            return res.json({ id: existing.rows[0].id, name: existing.rows[0].name, type: 'direct', existing: true });
        }
        
        const friendResult = await pool.query(`SELECT username FROM users WHERE id = $1`, [friendId]);
        const friendName = friendResult.rows[0]?.username || 'Чат';
        
        const roomResult = await pool.query(
            `INSERT INTO rooms (name, type, created_by) VALUES ($1, 'direct', $2) RETURNING id`,
            [friendName, req.user.id]
        );
        const roomId = roomResult.rows[0].id;
        
        await pool.query(`INSERT INTO room_members (room_id, user_id) VALUES ($1, $2)`, [roomId, req.user.id]);
        await pool.query(`INSERT INTO room_members (room_id, user_id) VALUES ($1, $2)`, [roomId, friendId]);
        
        res.json({ id: roomId, name: friendName, type: 'direct' });
    } catch (err) {
        res.status(500).json({ error: 'Error creating direct chat' });
    }
});

app.get('/api/messages/:roomId', authenticateToken, async (req, res) => {
    const { roomId } = req.params;
    const { limit = 100 } = req.query;
    try {
        const result = await pool.query(
            `SELECT * FROM messages WHERE room_id = $1 ORDER BY created_at DESC LIMIT $2`,
            [roomId, limit]
        );
        res.json(result.rows.reverse());
    } catch (err) {
        res.json([]);
    }
});

app.post('/api/upload', authenticateToken, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const fileUrl = `/uploads/${req.file.filename}`;
    const fileType = req.file.mimetype.startsWith('image/') ? 'image' : 'file';
    res.json({ fileUrl, fileType, originalName: req.file.originalname });
});

// WebSocket обработка
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
                    await pool.query(`UPDATE users SET online = true, last_seen = CURRENT_TIMESTAMP WHERE id = $1`, [currentUser.id]);
                    
                    // Получаем комнаты
                    const roomsResult = await pool.query(`
                        SELECT DISTINCT r.* FROM rooms r
                        LEFT JOIN room_members rm ON rm.room_id = r.id
                        WHERE rm.user_id = $1 OR r.type = 'public'
                        ORDER BY r.created_at DESC
                    `, [currentUser.id]);
                    
                    const rooms = [];
                    for (const room of roomsResult.rows) {
                        if (room.type === 'direct') {
                            const otherMember = await pool.query(`
                                SELECT u.username FROM room_members rm
                                JOIN users u ON u.id = rm.user_id
                                WHERE rm.room_id = $1 AND rm.user_id != $2
                            `, [room.id, currentUser.id]);
                            rooms.push({ ...room, displayName: otherMember.rows[0]?.username || room.name });
                        } else {
                            rooms.push({ ...room, displayName: room.name });
                        }
                    }
                    ws.send(JSON.stringify({ type: 'rooms_list', rooms }));
                    
                    // Друзья
                    const friendsResult = await pool.query(`
                        SELECT DISTINCT u.id, u.username, u.online FROM friends f
                        JOIN users u ON (u.id = f.friend_id OR u.id = f.user_id)
                        WHERE (f.user_id = $1 OR f.friend_id = $1) AND u.id != $1 AND f.status = 'accepted'
                    `, [currentUser.id]);
                    ws.send(JSON.stringify({ type: 'friends_list', friends: friendsResult.rows }));
                    
                    // Запросы
                    const requestsResult = await pool.query(`
                        SELECT u.id, u.username, u.online, f.id as request_id
                        FROM friends f JOIN users u ON u.id = f.user_id
                        WHERE f.friend_id = $1 AND f.status = 'pending'
                    `, [currentUser.id]);
                    ws.send(JSON.stringify({ type: 'friend_requests', requests: requestsResult.rows }));
                    break;
                }
                case 'join_room': {
                    currentRoom = parsed.roomId;
                    if (!roomConnections.has(currentRoom)) roomConnections.set(currentRoom, new Set());
                    roomConnections.get(currentRoom).add(currentUser.id);
                    
                    const messagesResult = await pool.query(
                        `SELECT * FROM messages WHERE room_id = $1 ORDER BY created_at ASC LIMIT 100`,
                        [currentRoom]
                    );
                    ws.send(JSON.stringify({ type: 'history', messages: messagesResult.rows }));
                    break;
                }
                case 'message': {
                    const { message, roomId } = parsed;
                    const targetRoom = roomId || currentRoom;
                    await pool.query(
                        `INSERT INTO messages (room_id, user_id, username, message) VALUES ($1, $2, $3, $4)`,
                        [targetRoom, currentUser.id, currentUser.username, message]
                    );
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
                    const targetRoom = roomId || currentRoom;
                    await pool.query(
                        `INSERT INTO messages (room_id, user_id, username, message, file_url, file_type) VALUES ($1, $2, $3, $4, $5, $6)`,
                        [targetRoom, currentUser.id, currentUser.username, originalName, fileUrl, fileType]
                    );
                    broadcastToRoom(targetRoom, {
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
        } catch(e) { console.error('WebSocket error:', e); }
    });
    
    ws.on('close', async () => {
        if (currentUser) {
            clients.delete(currentUser.id);
            await pool.query(`UPDATE users SET online = false, last_seen = CURRENT_TIMESTAMP WHERE id = $1`, [currentUser.id]);
            broadcastToRoom(currentRoom, { type: 'user_left', username: currentUser.username });
        }
    });
});

function broadcastToRoom(roomId, data) {
    const roomUsers = roomConnections.get(roomId);
    if (!roomUsers) return;
    roomUsers.forEach(userId => {
        const client = clients.get(userId);
        if (client && client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data));
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Сервер запущен на http://localhost:${PORT}`));