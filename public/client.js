let socket;
let currentUser = null;
let currentRoom = 1;
let currentToken = null;
let typingTimeout = null;
let isTyping = false;

const emojis = ['😀', '😂', '😍', '😎', '😢', '😡', '👍', '❤️', '🔥', '🎉', '✨', '💀', '🐱', '🍕', '⚽', '🎮'];

// DOM элементы
const loginScreen = document.getElementById('loginScreen');
const chatScreen = document.getElementById('chatScreen');
const messagesDiv = document.getElementById('messages');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const currentUsername = document.getElementById('currentUsername');
const onlineStatus = document.getElementById('onlineStatus');
const roomsList = document.getElementById('roomsList');
const onlineUsersDiv = document.getElementById('onlineUsers');
const typingIndicator = document.getElementById('typingIndicator');
const emojiBtn = document.getElementById('emojiBtn');
const emojiPicker = document.getElementById('emojiPicker');
const fileBtn = document.getElementById('fileBtn');
const fileInput = document.getElementById('fileInput');
const logoutBtn = document.getElementById('logoutBtn');
const createRoomBtn = document.getElementById('createRoomBtn');
const notificationSound = document.getElementById('notificationSound');

// Аутентификация
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tab = btn.dataset.tab;
        document.getElementById('loginForm').style.display = tab === 'login' ? 'block' : 'none';
        document.getElementById('registerForm').style.display = tab === 'register' ? 'block' : 'none';
    });
});

document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('loginUsername').value;
    const password = document.getElementById('loginPassword').value;
    
    const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    });
    
    if (res.ok) {
        const data = await res.json();
        currentToken = data.token;
        currentUser = { id: data.userId, username: data.username };
        initChat();
    } else {
        alert('Ошибка входа');
    }
});

document.getElementById('registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('regUsername').value;
    const password = document.getElementById('regPassword').value;
    
    const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    });
    
    if (res.ok) {
        alert('Регистрация успешна! Теперь войдите.');
        document.querySelector('.tab-btn[data-tab="login"]').click();
    } else {
        alert('Ошибка регистрации');
    }
});

async function initChat() {
    loginScreen.style.display = 'none';
    chatScreen.style.display = 'flex';
    currentUsername.textContent = currentUser.username;
    
    // Загрузка комнат
    await loadRooms();
    
    // Подключение WebSocket
    connectWebSocket();
    
    // Загрузка истории
    await loadHistory(currentRoom);
}

function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${window.location.host}`);
    
    socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'auth', token: currentToken }));
        socket.send(JSON.stringify({ type: 'join_room', roomId: currentRoom }));
        onlineStatus.textContent = '🟢 Онлайн';
    };
    
    socket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        handleSocketMessage(data);
    };
    
    socket.onclose = () => {
        onlineStatus.textContent = '🔴 Офлайн';
        setTimeout(connectWebSocket, 3000);
    };
}

function handleSocketMessage(data) {
    switch(data.type) {
        case 'message':
            addMessageToChat(data, data.username === currentUser.username);
            if (data.username !== currentUser.username) {
                playNotification();
            }
            break;
        case 'file':
            addFileToChat(data, data.username === currentUser.username);
            break;
        case 'history':
            data.messages.forEach(msg => {
                addMessageToChat(msg, msg.username === currentUser.username, false);
            });
            break;
        case 'online_users':
            updateOnlineUsers(data.users);
            break;
        case 'user_joined':
            addSystemMessage(`${data.username} присоединился к чату`);
            playNotification();
            break;
        case 'user_left':
            addSystemMessage(`${data.username} покинул чат`);
            break;
        case 'typing':
            if (data.isTyping && data.username !== currentUser.username) {
                typingIndicator.textContent = `${data.username} печатает...`;
            } else if (!data.isTyping) {
                typingIndicator.textContent = '';
            }
            break;
    }
}

async function loadRooms() {
    const res = await fetch('/api/rooms', {
        headers: { 'Authorization': `Bearer ${currentToken}` }
    });
    const rooms = await res.json();
    
    roomsList.innerHTML = '';
    rooms.forEach(room => {
        const roomDiv = document.createElement('div');
        roomDiv.className = `room-item ${room.id === currentRoom ? 'active' : ''}`;
        roomDiv.innerHTML = `<i class="fas fa-hashtag"></i> ${room.name}`;
        roomDiv.onclick = () => switchRoom(room.id, room.name);
        roomsList.appendChild(roomDiv);
    });
}

async function loadHistory(roomId) {
    const res = await fetch(`/api/messages/${roomId}`, {
        headers: { 'Authorization': `Bearer ${currentToken}` }
    });
    const messages = await res.json();
    messagesDiv.innerHTML = '';
    messages.forEach(msg => {
        addMessageToChat(msg, msg.username === currentUser.username, false);
    });
}

function switchRoom(roomId, roomName) {
    currentRoom = roomId;
    document.getElementById('currentRoomName').textContent = roomName;
    socket.send(JSON.stringify({ type: 'join_room', roomId }));
    loadHistory(roomId);
    
    document.querySelectorAll('.room-item').forEach(item => {
        item.classList.remove('active');
        if (item.textContent.includes(roomName)) {
            item.classList.add('active');
        }
    });
}

function sendMessage() {
    const message = messageInput.value.trim();
    if (!message) return;
    
    socket.send(JSON.stringify({
        type: 'message',
        message: message,
        roomId: currentRoom
    }));
    
    messageInput.value = '';
    stopTyping();
}

async function sendFile() {
    const file = fileInput.files[0];
    if (!file) return;
    
    const formData = new FormData();
    formData.append('file', file);
    
    const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${currentToken}` },
        body: formData
    });
    
    if (res.ok) {
        const data = await res.json();
        socket.send(JSON.stringify({
            type: 'file',
            fileUrl: data.fileUrl,
            fileType: data.fileType,
            originalName: data.originalName,
            roomId: currentRoom
        }));
    }
}

function addMessageToChat(msg, isOwn, scroll = true) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${isOwn ? 'own' : 'other'} ${msg.isPrivate ? 'private' : ''}`;
    
    messageDiv.innerHTML = `
        <div class="message-header">
            <strong>${isOwn ? 'Вы' : msg.username}</strong> 
            <span>${new Date(msg.timestamp).toLocaleTimeString()}</span>
        </div>
        <div class="message-content">${escapeHtml(msg.message)}</div>
    `;
    
    messagesDiv.appendChild(messageDiv);
    if (scroll) messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function addFileToChat(data, isOwn) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${isOwn ? 'own' : 'other'}`;
    
    let content = '';
    if (data.fileType === 'image') {
        content = `<img src="${data.fileUrl}" class="message-image" onclick="window.open('${data.fileUrl}')">`;
    } else {
        content = `<a href="${data.fileUrl}" target="_blank">📎 ${data.originalName}</a>`;
    }
    
    messageDiv.innerHTML = `
        <div class="message-header">
            <strong>${isOwn ? 'Вы' : data.username}</strong>
        </div>
        <div class="message-content">${content}</div>
    `;
    
    messagesDiv.appendChild(messageDiv);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function addSystemMessage(text) {
    const sysDiv = document.createElement('div');
    sysDiv.style.textAlign = 'center';
    sysDiv.style.fontSize = '0.8rem';
    sysDiv.style.color = '#888';
    sysDiv.style.padding = '0.5rem';
    sysDiv.textContent = text;
    messagesDiv.appendChild(sysDiv);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function updateOnlineUsers(users) {
    onlineUsersDiv.innerHTML = '';
    users.forEach(userId => {
        const userDiv = document.createElement('div');
        userDiv.className = 'user-item';
        userDiv.innerHTML = `<i class="fas fa-circle" style="color: #4caf50; font-size: 0.6rem;"></i> Пользователь ${userId}`;
        userDiv.onclick = () => sendPrivateMessage(userId);
        onlineUsersDiv.appendChild(userDiv);
    });
}

function sendPrivateMessage(userId) {
    const message = prompt('Введите личное сообщение:');
    if (message) {
        socket.send(JSON.stringify({
            type: 'message',
            message: `(личное) ${message}`,
            isPrivate: true,
            privateTo: userId
        }));
    }
}

function playNotification() {
    notificationSound.play().catch(e => console.log('Audio not supported'));
}

function startTyping() {
    if (!isTyping) {
        isTyping = true;
        socket.send(JSON.stringify({ type: 'typing', isTyping: true }));
    }
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(stopTyping, 1000);
}

function stopTyping() {
    if (isTyping) {
        isTyping = false;
        socket.send(JSON.stringify({ type: 'typing', isTyping: false }));
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Event listeners
messageInput.addEventListener('input', startTyping);
sendBtn.addEventListener('click', sendMessage);
messageInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
});

emojiBtn.addEventListener('click', () => {
    emojiPicker.style.display = emojiPicker.style.display === 'none' ? 'grid' : 'none';
    
    if (emojiPicker.children.length === 0) {
        emojis.forEach(emoji => {
            const span = document.createElement('span');
            span.textContent = emoji;
            span.onclick = () => {
                messageInput.value += emoji;
                emojiPicker.style.display = 'none';
                messageInput.focus();
            };
            emojiPicker.appendChild(span);
        });
    }
});

fileBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', sendFile);
logoutBtn.addEventListener('click', () => {
    socket.close();
    location.reload();
});
createRoomBtn.addEventListener('click', () => {
    const name = prompt('Название комнаты:');
    if (name) {
        fetch('/api/rooms', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ name })
        }).then(() => loadRooms());
    }
});

// Закрыть emoji picker при клике вне
document.addEventListener('click', (e) => {
    if (!emojiBtn.contains(e.target) && !emojiPicker.contains(e.target)) {
        emojiPicker.style.display = 'none';
    }
});