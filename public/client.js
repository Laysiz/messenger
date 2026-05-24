const messagesDiv = document.getElementById('messages');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const statusDiv = document.getElementById('status');

let socket;
let username = prompt('Введите ваше имя:', 'Гость') || 'Аноним';

// Функция подключения WebSocket
function connect() {
    // Определяем URL WebSocket (локально или на Render)
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    
    socket = new WebSocket(wsUrl);
    
    socket.onopen = () => {
        statusDiv.innerHTML = '🟢 Онлайн';
        statusDiv.style.background = 'rgba(0,255,0,0.3)';
        addSystemMessage('Вы подключились к чату');
    };
    
    socket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        displayMessage(data.username, data.text, data.username === username);
    };
    
    socket.onclose = () => {
        statusDiv.innerHTML = '🔴 Офлайн';
        statusDiv.style.background = 'rgba(255,0,0,0.3)';
        addSystemMessage('Соединение потеряно. Переподключение через 3 секунды...');
        setTimeout(connect, 3000);
    };
    
    socket.onerror = (error) => {
        console.error('WebSocket error:', error);
    };
}

// Отправка сообщения
function sendMessage() {
    const text = messageInput.value.trim();
    if (text && socket && socket.readyState === WebSocket.OPEN) {
        const message = {
            username: username,
            text: text,
            timestamp: new Date().toLocaleTimeString()
        };
        socket.send(JSON.stringify(message));
        messageInput.value = '';
    }
}

// Отображение сообщения в чате
function displayMessage(username, text, isOwn) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${isOwn ? 'own' : 'other'}`;
    
    const nameSpan = document.createElement('div');
    nameSpan.style.fontSize = '0.8rem';
    nameSpan.style.fontWeight = 'bold';
    nameSpan.style.marginBottom = '0.3rem';
    nameSpan.textContent = isOwn ? 'Вы' : username;
    
    const textSpan = document.createElement('div');
    textSpan.textContent = text;
    
    messageDiv.appendChild(nameSpan);
    messageDiv.appendChild(textSpan);
    
    messagesDiv.appendChild(messageDiv);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// Системное сообщение
function addSystemMessage(text) {
    const sysDiv = document.createElement('div');
    sysDiv.style.textAlign = 'center';
    sysDiv.style.fontSize = '0.8rem';
    sysDiv.style.color = '#888';
    sysDiv.style.margin = '0.5rem 0';
    sysDiv.textContent = text;
    messagesDiv.appendChild(sysDiv);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// Обработчики событий
sendBtn.addEventListener('click', sendMessage);
messageInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
});

// Запуск подключения
connect();