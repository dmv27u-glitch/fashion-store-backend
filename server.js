const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const fetch = require('node-fetch');
const cors = require('cors');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());
app.use(express.static('public'));

// ---------- БАЗА ДАННЫХ ----------
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
// Добавляем колонку address, если её нет
db.run(`ALTER TABLE orders ADD COLUMN customer_address TEXT`, (err) => {
  if (err && !err.message.includes('duplicate column name')) console.error(err.message);
});

// ---------- НАСТРОЙКА EMAIL (NODEMAILER) ----------
let transporter = null;
if (process.env.EMAIL_HOST && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT || 587,
    secure: (process.env.EMAIL_PORT == 465), // true для порта 465
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });
  console.log('✅ Email transporter настроен');
} else {
  console.log('⚠️ Email не настроен (пропущены переменные окружения EMAIL_HOST, EMAIL_USER, EMAIL_PASS)');
}

// Функция отправки письма покупателю
async function sendEmailNotification(toEmail, orderId, customerName) {
  if (!transporter) {
    console.log('Пропуск отправки email: transporter не настроен');
    return;
  }
  const subject = `Ваш заказ №${orderId} оформлен!`;
  const text = `Здравствуйте, ${customerName}!\n\nВаш заказ №${orderId} успешно оформлен.\nЕсли у вас возникнут вопросы, пишите в Telegram: @yooittt\n\nСпасибо за покупку!`;
  const html = `<p>Здравствуйте, ${customerName}!</p>
                <p>Ваш заказ №${orderId} успешно оформлен.</p>
                <p>Если у вас возникнут вопросы, пишите в Telegram: <b>@yooittt</b></p>
                <p>Спасибо за покупку!</p>`;
  try {
    let info = await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      to: toEmail,
      subject: subject,
      text: text,
      html: html,
    });
    console.log('✅ Email отправлен:', info.messageId);
  } catch (err) {
    console.error('❌ Ошибка отправки email:', err);
  }
}

// ---------- TELEGRAM ----------
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
    console.log('✅ Уведомление в Telegram отправлено');
  } catch (err) { console.error('❌ Ошибка Telegram:', err); }
}

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
  console.log('Получен запрос на /create-payment');
  const { customerName, customerEmail, customerAddress, items, totalAmount } = req.body;
  const orderId = `ORDER_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

  // Сохраняем заказ в БД
  db.run(
    `INSERT INTO orders (order_id, customer_name, customer_email, customer_address, items, total, status) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [orderId, customerName, customerEmail, customerAddress, JSON.stringify(items), totalAmount, 'pending'],
    (err) => { if (err) console.error('Ошибка вставки заказа:', err); }
  );

  // Если нет ключей ЮKassa — тестовый режим (имитируем оплату)
  if (!process.env.YOOKASSA_SHOP_ID || !process.env.YOOKASSA_SECRET_KEY) {
    console.log('ТЕСТОВЫЙ РЕЖИМ: заказ принят');
    setTimeout(async () => {
      db.run(`UPDATE orders SET status = 'paid' WHERE order_id = ?`, [orderId]);
      db.get(`SELECT * FROM orders WHERE order_id = ?`, [orderId], async (err, order) => {
        if (order) {
          await sendTelegramMessage(formatOrderMessage(order));
          await sendEmailNotification(customerEmail, orderId, customerName);
        }
      });
    }, 1000);
    return res.json({ success: true, paymentUrl: null, testMode: true, orderId });
  }

  // ---------- РЕАЛЬНЫЙ ПЛАТЕЖ ЧЕРЕЗ ЮKASSA ----------
  const auth = Buffer.from(`${process.env.YOOKASSA_SHOP_ID}:${process.env.YOOKASSA_SECRET_KEY}`).toString('base64');
  const paymentData = {
    amount: { value: totalAmount.toFixed(2), currency: 'RUB' },
    capture: true,
    confirmation: { type: 'redirect', return_url: 'https://ваш-сайт.netlify.app/thankyou.html' },
    description: `Заказ ${orderId}`,
    metadata: { orderId, customerEmail, customerName }
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

// ---------- WEBHOOK ДЛЯ ЮKASSA (ПОСЛЕ ОПЛАТЫ) ----------
app.post('/yookassa-webhook', async (req, res) => {
  const event = req.body;
  if (event.object && event.object.status === 'succeeded') {
    const orderId = event.object.metadata.orderId;
    const customerEmail = event.object.metadata.customerEmail;
    const customerName = event.object.metadata.customerName;
    db.run(`UPDATE orders SET status = 'paid' WHERE order_id = ?`, [orderId]);
    db.get(`SELECT * FROM orders WHERE order_id = ?`, [orderId], async (err, order) => {
      if (order) {
        await sendTelegramMessage(formatOrderMessage(order));
        if (customerEmail) await sendEmailNotification(customerEmail, orderId, customerName);
      }
    });
  }
  res.send('OK');
});

// ---------- ЗАПУСК ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
