/*
  PURIKURA BOOTH 用のかんたんローカルサーバーです。
  これを起動すると：
    1. このフォルダのファイル（index.html など）を配信します
    2. 完成写真をアップロードして保存する /upload を用意します
    3. QRコードで使う「このPCのWi-Fi上のアドレス」を /whoami で返します

  クラウド（Firebase等）を使わないので、料金も会員登録も一切不要です。
  スマホと、このPCが「同じWi-Fi」に繋がっていれば、QRコードで写真を受け取れます。

  使い方：
    1. Node.js をインストール（https://nodejs.org/）
    2. このフォルダで次を実行:
         node server.js
    3. 表示されたURL（例: http://localhost:3000）を、booth用PCのブラウザで開く
       ※ カメラを使うのでこのPC自身は必ず localhost（または 127.0.0.1）で開いてください
*/

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = 3000;
const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function getLocalIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  // 写真のアップロード（完成画像をJPEGとして保存する）
  if (req.method === 'POST' && req.url === '/upload') {
    try {
      const body = await readBody(req, 15 * 1024 * 1024); // 最大15MBまで
      const data = JSON.parse(body.toString('utf8'));
      const match = /^data:image\/(\w+);base64,(.+)$/.exec(data.image || '');
      if (!match) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid image data' }));
        return;
      }
      const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
      const buffer = Buffer.from(match[2], 'base64');
      const filename = `${Date.now()}_${crypto.randomBytes(5).toString('hex')}.${ext}`;
      fs.writeFileSync(path.join(UPLOAD_DIR, filename), buffer);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: `/uploads/${filename}` }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err.message || err) }));
    }
    return;
  }

  // QRコード生成用：このPCのWi-Fi上のIPアドレスを返す
  if (req.method === 'GET' && req.url === '/whoami') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ip: getLocalIp(), port: PORT }));
    return;
  }

  // 通常の静的ファイル配信（index.html, style.css, app.js, uploads/ 内の画像など）
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('ファイルが見つかりません: ' + urlPath);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
});

server.listen(PORT, () => {
  const ip = getLocalIp();
  console.log('====================================================');
  console.log('  PURIKURA BOOTH サーバーが起動しました！');
  console.log('====================================================');
  console.log(`  このPC用（カメラが使えるURL）: http://localhost:${PORT}`);
  console.log(`  QRコードは自動でこちらを使います: http://${ip}:${PORT}`);
  console.log('  スマホをこのPCと同じWi-Fiに繋いでおいてください。');
  console.log('====================================================');
});
