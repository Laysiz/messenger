const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const clients = new Set();

app.use(express.static('public'));

wss.on('connection', (ws) => {
  console.log('🔌 Новый клиент подключился');
  clients.add(ws);

  ws.on('message', (message) => {
    console.log('📨 Получено:', message.toString());
    
    // Отправляем сообщение ВСЕМ подключенным клиентам
    const messageText = message.toString();
    clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(messageText);
      }
    });
  });

  ws.on('close', () => {
    console.log('❌ Клиент отключился');
    clients.delete(ws);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Сервер на http://localhost:${PORT}`);
});