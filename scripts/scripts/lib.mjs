// Thư viện dùng chung cho sao lưu SMART VSMD (không cần cài thêm gói npm)
import crypto from 'node:crypto';
import zlib from 'node:zlib';

export const FOLDER_NAME = 'SMART_VSMD_Backup';
export const FILE_PREFIX = 'smartqc-backup-';

export function env(name, required = true) {
  const v = (process.env[name] || '').trim();
  if (!v && required) throw new Error(`Thiếu biến môi trường ${name}`);
  return v;
}

// ---------- Supabase ----------
export async function supabaseSession() {
  const url = env('SUPABASE_URL').replace(/\/+$/, '');
  const service = env('SUPABASE_SERVICE_ROLE_KEY', false);
  if (service) return { url, apikey: service, token: service, mode: 'service_role' };

  const apikey = env('SUPABASE_ANON_KEY');
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env('SUPABASE_EMAIL'), password: env('SUPABASE_PASSWORD') }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) {
    throw new Error(`Đăng nhập Supabase thất bại (${res.status}): ${j.error_description || j.msg || j.message || 'không rõ'}`);
  }
  return { url, apikey, token: j.access_token, mode: 'user' };
}

function sbHeaders(s, extra = {}) {
  return { apikey: s.apikey, Authorization: `Bearer ${s.token}`, ...extra };
}

async function pullPages(s, table, extraQuery, order) {
  const PAGE = 1000;
  const rows = [];
  let total = null;
  for (let from = 0; ; from += PAGE) {
    const url = `${s.url}/rest/v1/${table}?select=*${extraQuery}${order ? `&order=${order}` : ''}`;
    const res = await fetch(url, {
      headers: sbHeaders(s, { 'Range-Unit': 'items', Range: `${from}-${from + PAGE - 1}`, Prefer: 'count=exact' }),
    });
    if (res.status === 416) break;
    if (!res.ok) {
      const body = await res.text();
      const err = new Error(`Đọc bảng ${table} lỗi ${res.status}: ${body.slice(0, 200)}`);
      err.retryable = res.status === 400 && !!order;
      throw err;
    }
    const part = await res.json();
    rows.push(...part);
    const m = /\/(\d+|\*)$/.exec(res.headers.get('content-range') || '');
    if (m && m[1] !== '*') total = Number(m[1]);
    if (part.length < PAGE) break;
  }
  if (total !== null && rows.length !== total) {
    throw new Error(`Bảng ${table}: đọc được ${rows.length}/${total} dòng, không khớp`);
  }
  return rows;
}

export async function fetchAllRows(s, table, extraQuery = '') {
  let lastErr;
  for (const order of ['id.asc', 'created_at.asc', '']) {
    try {
      return await pullPages(s, table, extraQuery, order);
    } catch (e) {
      lastErr = e;
      if (!e.retryable) throw e;
    }
  }
  throw lastErr;
}

export async function upsertRows(s, table, rows) {
  if (!rows.length) return;
  const res = await fetch(`${s.url}/rest/v1/${table}`, {
    method: 'POST',
    headers: sbHeaders(s, { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ghi bảng ${table} lỗi ${res.status}: ${body.slice(0, 200)}`);
  }
}

// ---------- Mã hóa AES-256-GCM (nén gzip trước) ----------
const MAGIC = Buffer.from('SQCB1');

export function encryptBuffer(buf, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(zlib.gzipSync(buf)), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), enc]);
}

export function decryptBuffer(data, passphrase) {
  if (data.length < 50 || !data.subarray(0, 5).equals(MAGIC)) {
    throw new Error('Không phải file sao lưu SMART VSMD hợp lệ');
  }
  const salt = data.subarray(5, 21);
  const iv = data.subarray(21, 33);
  const tag = data.subarray(33, 49);
  const enc = data.subarray(49);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return zlib.gunzipSync(Buffer.concat([decipher.update(enc), decipher.final()]));
  } catch {
    throw new Error('Sai BACKUP_PASSPHRASE hoặc file bị hỏng');
  }
}

// ---------- Google Drive ----------
export async function googleAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env('GOOGLE_CLIENT_ID'),
      client_secret: env('GOOGLE_CLIENT_SECRET'),
      refresh_token: env('GOOGLE_REFRESH_TOKEN'),
      grant_type: 'refresh_token',
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) {
    throw new Error(`Lấy access token Google thất bại (${j.error || res.status}): ${j.error_description || ''}`);
  }
  return j.access_token;
}

async function gjson(token, url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`Google Drive lỗi ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

export async function ensureFolder(token, name = FOLDER_NAME) {
  const q = encodeURIComponent(`name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const found = await gjson(token, `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=1`);
  if (found?.files?.length) return found.files[0].id;
  const made = await gjson(token, 'https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' }),
  });
  return made.id;
}

export async function uploadFile(token, folderId, name, buf) {
  const boundary = 'sqc' + crypto.randomBytes(8).toString('hex');
  const meta = JSON.stringify({ name, parents: [folderId] });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
    buf,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  return gjson(token, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
}

export async function listBackups(token, folderId) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false and name contains '${FILE_PREFIX}'`);
  const r = await gjson(
    token,
    `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=${encodeURIComponent('createdTime desc')}&pageSize=1000&fields=files(id,name,createdTime)`,
  );
  return r?.files || [];
}

export async function deleteFile(token, id) {
  await gjson(token, `https://www.googleapis.com/drive/v3/files/${id}`, { method: 'DELETE' });
}
