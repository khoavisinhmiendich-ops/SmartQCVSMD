// Sao lưu dữ liệu SMART VSMD từ Supabase -> file nén + mã hóa -> Google Drive
// Tối ưu dung lượng: (1) bỏ qua nếu dữ liệu không đổi so với bản gần nhất,
// (2) chỉ giữ BACKUP_KEEP bản mới nhất (mặc định 6 bản = 6 tháng khi chạy mỗi tháng).
// An toàn: không tạo bản rỗng; kiểm tra kích thước + MD5 sau khi tải lên; chỉ dọn bản cũ sau khi bản mới đã đạt;
// nếu số dòng giảm quá 50% so với bản trước thì GIỮ NGUYÊN bản cũ và báo lỗi.
import crypto from 'node:crypto';
import {
  env, supabaseSession, fetchAllRows, upsertRows, encryptBuffer,
  googleAccessToken, ensureFolder, deleteFile, FILE_PREFIX,
} from './lib.mjs';

const REQUIRED_TABLE = 'smartqc_records';
const OPTIONAL_TABLES = ['smartqc_shared_state', 'smartqc_workspace_members'];
const KEEP = Math.max(2, Number(env('BACKUP_KEEP', false)) || 6);
const MAX_DROP = 0.5;
const FORCE = ['1', 'true', 'yes'].includes(env('BACKUP_FORCE', false).toLowerCase());

let session = null;

async function writeStatus(payload) {
  if (!session) return;
  try {
    await upsertRows(session, 'smartqc_backup_status', [
      { id: 'latest', payload, updated_at: new Date().toISOString() },
    ]);
  } catch (e) {
    console.warn('Không ghi được trạng thái vào smartqc_backup_status:', e.message);
  }
}

// ---------- Google Drive (có gắn dấu vân tay dữ liệu vào file) ----------
async function gjson(token, url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`Google Drive lỗi ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function listBackups(token, folderId) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false and name contains '${FILE_PREFIX}'`);
  const r = await gjson(
    token,
    `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=${encodeURIComponent('createdTime desc')}&pageSize=1000&fields=files(id,name,createdTime,size,appProperties)`,
  );
  return r?.files || [];
}

async function uploadFile(token, folderId, name, buf, appProperties) {
  const boundary = 'sqc' + crypto.randomBytes(8).toString('hex');
  const meta = JSON.stringify({ name, parents: [folderId], appProperties });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
    buf,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  return gjson(token, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size,md5Checksum', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
}

async function main() {
  const passphrase = env('BACKUP_PASSPHRASE');
  const ws = env('SUPABASE_WORKSPACE_ID', false);
  const filter = ws ? `&workspace_id=eq.${encodeURIComponent(ws)}` : '';

  session = await supabaseSession();
  console.log(`Đăng nhập Supabase OK (chế độ: ${session.mode})`);

  const tables = {};
  const counts = {};
  const warnings = [];

  tables[REQUIRED_TABLE] = await fetchAllRows(session, REQUIRED_TABLE, filter);
  counts[REQUIRED_TABLE] = tables[REQUIRED_TABLE].length;
  console.log(`${REQUIRED_TABLE}: ${counts[REQUIRED_TABLE]} dòng`);
  if (counts[REQUIRED_TABLE] === 0) {
    throw new Error(`Bảng ${REQUIRED_TABLE} trả về 0 dòng (có thể bị chặn quyền) - không tạo bản sao lưu rỗng`);
  }

  for (const t of OPTIONAL_TABLES) {
    try {
      tables[t] = await fetchAllRows(session, t, filter);
      counts[t] = tables[t].length;
      console.log(`${t}: ${counts[t]} dòng`);
    } catch (e) {
      warnings.push(`${t}: ${e.message}`);
      console.warn(`Bỏ qua ${t}: ${e.message}`);
    }
  }

  // Dấu vân tay của dữ liệu (không gồm thời điểm sao lưu) -> biết dữ liệu có thay đổi hay không
  const hash = crypto.createHash('sha256').update(JSON.stringify({ ws: ws || null, tables })).digest('hex');
  const rows = counts[REQUIRED_TABLE];

  const token = await googleAccessToken();
  const folderId = await ensureFolder(token);
  const all = await listBackups(token, folderId);
  const prev = all[0];

  if (!FORCE && prev?.appProperties?.hash === hash) {
    const since = String(prev.createdTime || '').slice(0, 10);
    console.log(`Dữ liệu không đổi so với bản ${prev.name} (${since}) -> bỏ qua, không tạo bản mới.`);
    await writeStatus({
      ok: true, skipped: true, at: new Date().toISOString(), file: prev.name, drive_file_id: prev.id,
      size_bytes: Number(prev.size) || undefined, counts,
      warnings: [...warnings, `Dữ liệu không thay đổi từ bản ${since} nên không tạo bản mới (tiết kiệm dung lượng Drive)`],
      kept: all.length,
    });
    return;
  }

  const prevRows = Number(prev?.appProperties?.rows) || 0;
  const dropped = prevRows > 0 && rows < prevRows * (1 - MAX_DROP);

  const createdAt = new Date().toISOString();
  const json = Buffer.from(JSON.stringify({ format: 'smartqc-backup-v1', created_at: createdAt, workspace: ws || null, counts, tables }));
  const encrypted = encryptBuffer(json, passphrase);
  const name = `${FILE_PREFIX}${createdAt.replace(/[:.]/g, '-')}.bin`;

  const file = await uploadFile(token, folderId, name, encrypted, { hash, rows: String(rows) });
  const md5 = crypto.createHash('md5').update(encrypted).digest('hex');
  if (Number(file.size) !== encrypted.length || (file.md5Checksum && file.md5Checksum !== md5)) {
    try { await deleteFile(token, file.id); } catch { /* bỏ qua */ }
    throw new Error('Bản vừa tải lên Drive không khớp kích thước/MD5 - đã xóa bản lỗi, giữ nguyên các bản cũ');
  }
  console.log(`Đã tải lên Drive: ${file.name} (${encrypted.length} byte, MD5 khớp)`);

  if (dropped) {
    const msg = `Số dòng giảm từ ${prevRows} xuống ${rows} (quá ${MAX_DROP * 100}%): đã lưu bản mới nhưng KHÔNG xóa bản cũ. Hãy kiểm tra dữ liệu Supabase.`;
    await writeStatus({ ok: false, at: createdAt, file: file.name, drive_file_id: file.id, size_bytes: encrypted.length, counts, warnings, kept: all.length + 1, error: msg });
    throw new Error(msg);
  }

  // Dọn bản cũ SAU khi bản mới đã đạt: tổng cộng chỉ giữ KEEP bản (gồm bản mới)
  const old = all.slice(KEEP - 1);
  for (const f of old) await deleteFile(token, f.id);
  if (old.length) console.log(`Đã xóa ${old.length} bản cũ (giữ ${KEEP} bản mới nhất)`);

  await writeStatus({
    ok: true, at: createdAt, file: file.name, drive_file_id: file.id,
    size_bytes: encrypted.length, counts, warnings, kept: Math.min(all.length + 1, KEEP),
  });
  console.log(`XONG. smartqc_records = ${rows} dòng. Đối chiếu với: select count(*) from public.smartqc_records;`);
}

main().catch(async (e) => {
  console.error('LỖI SAO LƯU:', e.message);
  await writeStatus({ ok: false, at: new Date().toISOString(), error: String(e.message).slice(0, 300) });
  process.exit(1);
});
