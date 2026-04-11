const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const fetch = require('node-fetch');
const cors = require('cors');
require('dotenv').config();

const app = express();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());
app.use(express.static('public'));

const db = new sqlite3.Database('./database.sqlite');
db.run(`CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT UNIQUE,
  customer_name TEXT,
  customer_email TEXT,
  customer_address TEXT,
  items TEXT,
  total INTEGER,
  status TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
db.run(`ALTER TABLE orders ADD COLUMN customer_address TEXT`, (err) => {
  if (err && !err.message.includes('duplicate column name')) console.error(err.message);
});

async function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
    console.log('✅ Telegram sent');
  } catch (err) { console.error(err); }
}

function formatOrderMessage(order) {
  const items = JSON.parse(order.items);
  let itemsText = '';
  items.forEach(item => {
    itemsText += `• ${item.name} — ${item.quantity} шт. x ${item.price}₽ = ${item.quantity * item.price}₽\n`;
  });
  return `🛍 <b>НОВЫЙ ЗАКАЗ</b>\n\n<b>№:</b> ${order.order_id}\n<b>Покупатель:</b> ${order.customer_name}\n<b>Email:</b> ${order.customer_email}\n<b>Адрес:</b> ${order.customer_address}\n<b>Товары:</b>\n${itemsText}\n<b>Итого:</b> ${order.total}₽`;
}

app.post('/create-payment', async (req, res) => {
  const { customerName, customerEmail, customerAddress, items, totalAmount } = req.body;
  const orderId = `ORDER_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  db.run(`INSERT INTO orders (order_id, customer_name, customer_email, customer_address, items, total, status) VALUES (?,?,?,?,?,?,?)`,
    [orderId, customerName, customerEmail, customerAddress, JSON.stringify(items), totalAmount, 'pending']);
  
  if (!process.env.YOOKASSA_SHOP_ID || !process.env.YOOKASSA_SECRET_KEY) {
    setTimeout(async () => {
      db.run(`UPDATE orders SET status = 'paid' WHERE order_id = ?`, [orderId]);
      db.get(`SELECT * FROM orders WHERE order_id = ?`, [orderId], async (err, order) => {
        if (order) await sendTelegramMessage(formatOrderMessage(order));
      });
    }, 1000);
    return res.json({ success: true, paymentUrl: null, testMode: true, orderId });
  }
  // ЮKassa реальный код (опущен для краткости, но вы можете оставить как было)
  res.json({ success: false, error: 'ЮKassa не настроен' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
