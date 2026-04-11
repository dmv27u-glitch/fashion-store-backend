const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();

// Явная настройка CORS (разрешаем все источники для теста)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());
app.use(express.static('public'));

// ---------- БАЗА ДАННЫХ ----------
const db = new sqlite3.Database('./database.sqlite');

// Создаём таблицу orders, если её нет
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

// Добавляем колонку customer_address для старых баз (если её нет)
db.run(`ALTER TABLE orders ADD COLUMN customer_address TEXT`, (err) => {
  if (err && !err.message.includes('duplicate column name')) {
    console.error('Ошибка при добавлении колонки address:', err.message);
  }
});

// ---------- ОТПРАВКА В TELEGRAM (с подробными логами) ----------
async function sendTelegramMessage(text) {
  console.log('=== ОТЛАДКА: функция sendTelegramMessage вызвана ===');
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  console.log('TELEGRAM_BOT_TOKEN:', token ? 'УСТАНОВЛЕН' : 'ОТСУТСТВУЕТ');
  console.log('TELEGRAM_CHAT_ID:', chatId ? 'УСТАНОВЛЕН' : 'ОТСУТСТВУЕТ');

  if (!token || !chatId) {
    console.log('ОШИБКА: не заданы токен или chatId');
    return;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  console.log('URL запроса (токен скрыт):', url.replace(token, 'HIDDEN'));

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML'
      })
    });
    const data = await response.json();
    console.log('Ответ от Telegram API:', data);
    if (!response.ok) {
      console.error('Ошибка Telegram API:', data);
    } else {
      console.log('Сообщение успешно отправлено в Telegram');
    }
  } catch (err) {
    console.error('Исключение при отправке в Telegram:', err.message);
  }
}

// Формирование красивого сообщения с адресом
function formatOrderMessage(order) {
  const items = JSON.parse(order.items);
  let itemsText = '';
  items.forEach(item => {
    itemsText += `• ${item.name} — ${item.quantity} шт. x ${item.price}₽ = ${item.quantity * item.price}₽\n`;
  });
  return `🛍 <b>НОВЫЙ ЗАКАЗ ОПЛАЧЕН!</b>\n\n<b>№ заказа:</b> ${order.order_id}\n<b>Покупатель:</b> ${order.customer_name}\n<b>Email:</b> ${order.customer_email}\n<b>Адрес доставки:</b> ${order.customer_address}\n<b>Товары:</b>\n${itemsText}\n<b>Итого:</b> ${order.total}₽\n<b>Дата оплаты:</b> ${order.created_at}`;
}

// ---------- СОЗДАНИЕ ПЛАТЕЖА (ТЕСТОВЫЙ РЕЖИМ + ЮKASSA) ----------
app.post('/create-payment', async (req, res) => {
  console.log('Получен запрос на /create-payment от', req.headers.origin);
  const { customerName, customerEmail, customerAddress, items, totalAmount } = req.body;
  const orderId = `ORDER_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

  // Сохраняем заказ в БД
  db.run(
    `INSERT INTO orders (order_id, customer_name, customer_email, customer_address, items, total, status) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [orderId, customerName, customerEmail, customerAddress, JSON.stringify(items), totalAmount, 'pending'],
    function(err) {
      if (err) console.error('Ошибка вставки заказа:', err);
      else console.log('Заказ сохранён в БД, orderId:', orderId);
    }
  );

  // Если нет ключей ЮKassa — тестовый режим
  if (!process.env.YOOKASSA_SHOP_ID || !process.env.YOOKASSA_SECRET_KEY) {
    console.log('ТЕСТОВЫЙ РЕЖИМ: заказ создан, через 1 сек отправим уведомление');
    setTimeout(async () => {
      db.run(`UPDATE orders SET status = 'paid' WHERE order_id = ?`, [orderId]);
      db.get(`SELECT * FROM orders WHERE order_id = ?`, [orderId], async (err, order) => {
        if (order) {
          await sendTelegramMessage(formatOrderMessage(order));
        } else {
          console.error('Не найден заказ для уведомления', orderId);
        }
      });
    }, 1000);
    return res.json({ success: true, paymentUrl: null, testMode: true, orderId });
  }

  // ---------- РЕАЛЬНАЯ ИНТЕГРАЦИЯ С ЮKASSA ----------
  const auth = Buffer.from(`${process.env.YOOKASSA_SHOP_ID}:${process.env.YOOKASSA_SECRET_KEY}`).toString('base64');
  const paymentData = {
    amount: { value: totalAmount.toFixed(2), currency: 'RUB' },
    capture: true,
    confirmation: { type: 'redirect', return_url: 'https://ваш-сайт.netlify.app/thankyou.html' },
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
      throw new Error('Ошибка создания платежа: ' + JSON.stringify(payment));
    }
  } catch (error) {
    console.error('Ошибка ЮKassa:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------- WEBHOOK ДЛЯ ЮKASSA (УВЕДОМЛЕНИЕ ОБ УСПЕШНОЙ ОПЛАТЕ) ----------
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

// ---------- ЗАПУСК СЕРВЕРА ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
