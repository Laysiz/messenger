let socket;
let currentUser = null;
let currentRoom = 1;
let currentToken = null;
let typingTimeout = null;
let isTyping = false;

const emojis = ['😀', '😂', '😍', '😎', '😢', '😡', '👍', '❤️', '🔥', '🎉', '✨', '💀', '🐱', '🍕', '⚽', '🎮'];

const loginScreen = document.getElementById('loginScreen');
const chatScreen = document.getElementById('chatScreen');
const messagesDiv = document.getElementById('messages');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const currentUsername = document.getElementById('currentUsername');
const onlineStatus = document.getElementById('onlineStatus');
const roomsList = document.getElementById('roomsList');
const friendsList = document.getElementById('friendsList');
const typingIndicator = document.getElementById('typingIndicator');
const emojiBtn = document.getElementById('emojiBtn');
const emojiPicker = document.getElementById('emojiPicker');
const fileBtn = document.getElementById('fileBtn');
const fileInput = document.getElementById('fileInput');
const logoutBtn = document.getElementById('logoutBtn');
const notificationSound = document.getElementById('notificationSound');
const createGroupBtn = document.getElementById('createGroupBtn');
const createDirectBtn = document.getElementById('createDirectBtn');

let rooms = [];
let friends = [];

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
    
    await loadFriends();
    connectWebSocket();
}

function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${window.location.host}`);
    
    socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'auth', token: currentToken }));
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
        case 'rooms_list':
            rooms = data.rooms;
            renderRooms();
            break;
        case 'friends_list':
            friends = data.friends;
            renderFriends();
            break;
        case 'message':
            addMessageToChat(data, data.username === currentUser.username);
            if (data.username !== currentUser.username) playNotification();
            break;
        case 'file':
            addFileToChat(data, data.username === currentUser.username);
            break;
        case 'history':
            messagesDiv.innerHTML = '';
            data.messages.forEach(msg => {
                addMessageToChat(msg, msg.username === currentUser.username, false);
            });
            break;
        case 'typing':
            if (data.isTyping && data.username !== currentUser.username) {
                typingIndicator.textContent = `${data.username} печатает...`;
            } else if (!data.isTyping) {
                typingIndicator.textContent = '';
            }
            break;
        case 'user_left':
            addSystemMessage(`${data.username} покинул чат`);
            break;
    }
}

async function loadFriends() {
    const res = await fetch('/api/friends', {
        headers: { 'Authorization': `Bearer ${currentToken}` }
    });
    friends = await res.json();
    renderFriends();
}

function renderRooms() {
    roomsList.innerHTML = '';
    rooms.forEach(room => {
        const roomDiv = document.createElement('div');
        roomDiv.className = `room-item ${room.id === currentRoom ? 'active' : ''}`;
        
        let icon = room.type === 'public' ? 'fa-hashtag' : (room.type === 'direct' ? 'fa-user' : 'fa-users');
        let typeLabel = room.type === 'public' ? 'Публичный' : (room.type === 'direct' ? 'Личный' : 'Группа');
        
        roomDiv.innerHTML = `
            <div style="flex:1">
                <i class="fas ${icon}"></i> ${room.name}
                <div class="room-type">${typeLabel}</div>
            </div>
        `;
        
        roomDiv.onclick = () => switchRoom(room.id, room.name, room.type);
        roomsList.appendChild(roomDiv);
    });
}

function renderFriends() {
    friendsList.innerHTML = '';
    friends.forEach(friend => {
        const friendDiv = document.createElement('div');
        friendDiv.className = 'friend-item';
        friendDiv.innerHTML = `
            <div>
                <span class="friend-status ${friend.online ? 'online' : 'offline'}"></span>
                ${friend.username}
            </div>
            <button class="icon-btn chat-with-friend" data-id="${friend.id}">
                <i class="fas fa-comment"></i>
            </button>
        `;
        
        friendDiv.querySelector('.chat-with-friend').onclick = (e) => {
            e.stopPropagation();
            startDirectChat(friend.id);
        };
        
        friendsList.appendChild(friendDiv);
    });
}

async function startDirectChat(friendId) {
    const res = await fetch('/api/rooms/direct', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${currentToken}`
        },
        body: JSON.stringify({ friendId })
    });
    
    if (res.ok) {
        const room = await res.json();
        await loadRooms();
        switchRoom(room.id, 'Личный чат', 'direct');
    }
}

async function loadRooms() {
    const res = await fetch('/api/rooms', {
        headers: { 'Authorization': `Bearer ${currentToken}` }
    });
    rooms = await res.json();
    renderRooms();
}

function switchRoom(roomId, roomName, roomType) {
    currentRoom = roomId;
    document.getElementById('currentRoomName').textContent = roomName;
    socket.send(JSON.stringify({ type: 'join_room', roomId }));
    
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
    messageDiv.className = `message ${isOwn ? 'own' : 'other'}`;
    
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
       