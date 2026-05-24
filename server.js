const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const clients = new Set();

// Явно указываем путь к папке public
app.use(express.static(path.join(__dirname, 'public')));

// Для всех остальных запросов отдаем index.html
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

wss.on('connection', (ws) => {
    console.log('Клиент подключился, всего:', clients.size + 1);
    clients.add(ws);

    ws.on('message', (message) => {
        const messageStr = message.toString();
        console.log('Получено сообщение:', messageStr);
        
        // Отправляем ВСЕМ клиентам
        clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(messageStr);
            }
        });
    });

    ws.on('close', () => {
        console.log('Клиент отключился');
        clients.delete(ws);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на http://localhost:${PORT}`);
});