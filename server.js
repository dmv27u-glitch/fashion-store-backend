const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();          // 👈 ЭТА СТРОКА ДОЛЖНА БЫТЬ ДО app.use()
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ... остальной код (база данных, маршруты, запуск сервера) ...
// Раздаём статические файлы из папки public (туда положим index.html)
app.use(express.static('public'));

// ---------- КОНФИГУРАЦИЯ (заполните своими данными) ----------
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN; // от @BotFather
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;     // ваш ID
const YOOKASSA_SHOP_ID = process.env.YOOKASSA_SHOP_ID;     // из личного кабинета ЮKassa
const YOOKASSA_SECRET_KEY = process.env.YOOKASSA_SECRET_KEY;

// База данных (создастся автоматически)
const db = new sqlite3.Database('./database.sqlite');
db.run(`CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT UNIQUE,
  customer_name TEXT,
  customer_email TEXT,
  items TEXT,
  total INTEGER,
  status TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Отправка сообщения в Telegram
async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: text,
      parse_mode: 'HTML'
    })
  });
}

// Форматирование заказа в красивую таблицу
function formatOrderMessage(order) {
  const items = JSON.parse(order.items);
  let itemsText = '';
  items.forEach(item => {
    itemsText += `• ${item.name} — ${item.quantity} шт. x ${item.price}₽ = ${item.quantity * item.price}₽\n`;
  });
  return `🛍 <b>НОВЫЙ ЗАКАЗ ОПЛАЧЕН!</b>\n\n<b>№ заказа:</b> ${order.order_id}\n<b>Покупатель:</b> ${order.customer_name}\n<b>Email:</b> ${order.customer_email}\n<b>Товары:</b>\n${itemsText}\n<b>Итого:</b> ${order.total}₽\n<b>Дата оплаты:</b> ${order.created_at}`;
}

// 1. Создание платежа (вызывается из браузера)
app.post('/create-payment', async (req, res) => {
  const { customerName, customerEmail, items, totalAmount } = req.body;
  const orderId = `ORDER_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

  // Сохраняем заказ в БД
  db.run(`INSERT INTO orders (order_id, customer_name, customer_email, items, total, status) VALUES (?, ?, ?, ?, ?, ?)`,
    [orderId, customerName, customerEmail, JSON.stringify(items), totalAmount, 'pending']);

  // Если нет ключей ЮKassa — тестовый режим (имитируем оплату)
  if (!YOOKASSA_SHOP_ID || !YOOKASSA_SECRET_KEY) {
    setTimeout(async () => {
      db.run(`UPDATE orders SET status = 'paid' WHERE order_id = ?`, [orderId]);
      const order = await new Promise((resolve) => {
        db.get(`SELECT * FROM orders WHERE order_id = ?`, [orderId], (err, row) => resolve(row));
      });
      await sendTelegramMessage(formatOrderMessage(order));
    }, 1000);
    return res.json({ success: true, paymentUrl: null, testMode: true, orderId });
  }

  // Реальная интеграция с ЮKassa
  const auth = Buffer.from(`${YOOKASSA_SHOP_ID}:${YOOKASSA_SECRET_KEY}`).toString('base64');
  const paymentData = {
    amount: { value: totalAmount.toFixed(2), currency: 'RUB' },
    capture: true,
    confirmation: { type: 'redirect', return_url: 'https://ваш-сайт.ру/thankyou.html' },
    description: `Заказ ${orderId}`,
    metadata: { orderId }
  };

  try {
    const response = await fetch('https://api.yookassa.ru/v3/payments', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
        'Idempotence-Key': orderId
      },
      body: JSON.stringify(paymentData)
    });
    const payment = await response.json();
    if (payment.confirmation && payment.confirmation.confirmation_url) {
      db.run(`UPDATE orders SET status = 'awaiting_payment' WHERE order_id = ?`, [orderId]);
      res.json({ success: true, paymentUrl: payment.confirmation.confirmation_url, orderId });
    } else {
      throw new Error('Ошибка создания платежа');
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. Webhook для уведомлений от ЮKassa (когда оплата прошла)
app.post('/yookassa-webhook', async (req, res) => {
  const event = req.body;
  if (event.object && event.object.status === 'succeeded') {
    const orderId = event.object.metadata.orderId;
    db.run(`UPDATE orders SET status = 'paid' WHERE order_id = ?`, [orderId]);
    db.get(`SELECT * FROM orders WHERE order_id = ?`, [orderId], async (err, order) => {
      if (order) {
        await sendTelegramMessage(formatOrderMessage(order));
      }
    });
  }
  res.send('OK');
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
