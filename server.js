const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Хранилище активных соединений
const clients = new Set();

// Обслуживание статических файлов
app.use(express.static('public'));

// WebSocket соединение
wss.on('connection', (ws) => {
  console.log('🔌 Новый клиент подключился');
  clients.add(ws);

  // Приём сообщений от клиента
  ws.on('message', (message) => {
    console.log('📨 Сообщение получено:', message.toString());
    
    // Отправляем сообщение всем подключённым клиентам
    const data = message.toString();
    broadcast(data, ws);
  });

  // Обработка закрытия соединения
  ws.on('close', () => {
    console.log('❌ Клиент отключился');
    clients.delete(ws);
  });
});

// Функция широковещательной рассылки
function broadcast(message, sender) {
  clients.forEach((client) => {
    if (client !== sender && client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// Запуск сервера
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Сервер запущен на http://localhost:${PORT}`);
});