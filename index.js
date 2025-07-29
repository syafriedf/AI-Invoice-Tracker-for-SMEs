require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleAuth } = require('google-auth-library');
const { google } = require('googleapis');
const { OpenAI } = require('openai');
const Tesseract = require('tesseract.js');
const pdf = require('pdf-parse');
const jimp = require('jimp');
const fs = require('fs');

// === Konfigurasi Environment ===
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4-turbo';
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const OCR_LANGUAGE = process.env.OCR_LANGUAGE || 'ind+eng';
const SESSION_DIR = process.env.SESSION_DIR || './wwebjs_sessions/';

// === Inisialisasi OpenAI ===
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// === Pastikan Folder Session Ada ===
if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

// === Inisialisasi WhatsApp Client ===
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

// === Google Sheets Auth ===
const auth = new GoogleAuth({
  keyFile: 'credentials.json',
  scopes: 'https://www.googleapis.com/auth/spreadsheets'
});

// === QR Code Login ===
client.on('qr', qr => qrcode.generate(qr, { small: true }));

// === WA Ready ===
client.on('ready', () => {
  console.log('✅ WhatsApp client ready');
  console.log('🔔 Bot berjalan di nomor:', client.info.wid._serialized.replace('@c.us',''));
});

// === Handle Pesan Media ===
client.on('message', async msg => {
  if (msg.hasMedia) {
    try {
      const media = await msg.downloadMedia();
      const buffer = Buffer.from(media.data, 'base64');

      console.log(`📩 Memproses media dari ${msg.from}`);
      const invoiceData = await processMedia(buffer, media.mimetype);

      await saveToSheet(invoiceData);

      const recapMessage = `✅ Invoice berhasil direkam:\n\n` +
        `📄 *Nomor*: ${invoiceData.invoiceNo}\n` +
        `📅 *Tanggal*: ${invoiceData.date}\n` +
        `🏢 *Penjual*: ${invoiceData.seller}\n` +
        `🧍‍♂️ *Pembeli*: ${invoiceData.buyer}\n` +
        `🧾 *Pajak (Tax)*: Rp ${invoiceData.tax.toLocaleString('id-ID')}\n` +
        `💰 *Total*: Rp ${invoiceData.total.toLocaleString('id-ID')}\n\n` +
        `📦 *Detail Barang:*\n` +
        invoiceData.items.map((item, i) =>
          `${i + 1}. ${item.name} (${item.quantity} x Rp ${item.unitPrice.toLocaleString('id-ID')}) = Rp ${item.subtotal.toLocaleString('id-ID')}`
        ).join('\n');

      msg.reply(recapMessage);
      msg.reply('✅ Invoice berhasil direkam ke Google Sheets!');
    } catch (error) {
      console.error('❌ Gagal proses media:', error);
      msg.reply(`❌ Gagal memproses invoice: ${error.message}`);
    }
  }
});

// === Proses Media PDF atau Gambar ===
async function processMedia(buffer, mimetype) {
  let text;

  if (mimetype === 'application/pdf') {
    const data = await pdf(buffer);
    text = data.text;
  } else if (mimetype.includes('image')) {
    const image = await jimp.read(buffer);
    const processed = await enhanceImage(image);
    const finalBuffer = await processed.getBufferAsync(jimp.MIME_JPEG);

    const { data: { text: ocrText } } = await Tesseract.recognize(
      finalBuffer,
      OCR_LANGUAGE,
      {
        logger: info => console.log(info.status),
        tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz./:- ',
        preserve_interword_spaces: 1
      }
    );
    text = ocrText;
  } else {
    throw new Error('📎 Tipe file tidak didukung');
  }

  return parseWithOpenAI(text);
}

// === Enhance Gambar untuk OCR ===
async function enhanceImage(image) {
  return image
    .greyscale()
    .contrast(0.5)
    .normalize()
    .quality(100);
}

// === Parsing Invoice via OpenAI ===
async function parseWithOpenAI(text) {
  const prompt = `
Anda adalah sistem ekstraksi data invoice profesional. Ekstrak informasi berikut dari teks invoice di bawah ini:

1. Nomor Invoice (format: INV-XXXX)
2. Tanggal Invoice (format: DD/MM/YYYY)
3. Nama Penjual
4. Nama Pembeli
5. Daftar barang (Nama barang, Kuantitas, Harga satuan, Subtotal)
6. Pajak (dalam angka, jika ada. Jika tidak ada, isi dengan 0)
7. Total

Format output JSON:
{
  "invoiceNo": "string",
  "date": "string",
  "seller": "string",
  "buyer": "string",
  "items": [
    {
      "name": "string",
      "quantity": number,
      "unitPrice": number,
      "subtotal": number
    }
  ],
  "tax": number,
  "total": number
}

Jika informasi tidak ditemukan, gunakan null. Tanggal harus dalam format DD/MM/YYYY.

Teks invoice aktual:
${text.substring(0, 4000)}
`;

  const response = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: "Anda adalah ahli ekstraksi data terstruktur dari dokumen invoice." },
      { role: "user", content: prompt }
    ],
    temperature: 0.2,
    max_tokens: 2000
  });

  let content = response.choices[0].message.content.trim();

  // Bersihkan jika dibungkus ```
  if (content.startsWith("```")) {
    content = content.replace(/```(json)?/g, '').trim();
  }

  const parsed = JSON.parse(content);

  if (!parsed.invoiceNo || !parsed.date) {
    throw new Error('🧾 Data invoice tidak lengkap');
  }

  // Fallback jika tidak ada pajak
  if (typeof parsed.tax !== 'number') {
    parsed.tax = 0;
  }

  return parsed;
}

// === Simpan ke Google Sheet ===
async function saveToSheet(invoiceData) {
  const sheets = google.sheets({ version: 'v4', auth });
  const timestamp = new Date().toISOString();

  const rows = invoiceData.items.map(item => [
    invoiceData.invoiceNo,
    invoiceData.date,
    invoiceData.seller,
    invoiceData.buyer,
    item.name,
    item.quantity,
    item.unitPrice,
    item.subtotal,
    invoiceData.tax,
    invoiceData.total,
    timestamp
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Sheet1!A:A',
    valueInputOption: 'USER_ENTERED',
    resource: { values: rows }
  });

  console.log(`✅ Tersimpan di Google Sheet (${rows.length} baris)`);
}

// === Jalankan Bot ===
client.initialize();

// === Tangani Error ===
process.on('unhandledRejection', error => {
  console.error('❗ Unhandled Rejection:', error);
});
