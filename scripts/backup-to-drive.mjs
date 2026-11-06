// Sao lưu dữ liệu SMART VSMD từ Supabase -> file mã hóa -> Google Drive
import {
  env, supabaseSession, fetchAllRows, upsertRows, encryptBuffer,
  googleAccessToken, ensureFolder, uploadFile, listBackups, deleteFile, FILE_PREFIX,
} from './lib.mjs';

const REQUIRED_TABLE = 'smartqc_records';
const OPTIONAL_TABLES = ['smartqc_shared_state', 'smartqc_workspace_members'];
const KEEP = Math.max(1, Number(env('BACKUP_KEEP', false)) || 60); // số bản giữ lại trên Drive

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

  const createdAt = new Date().toISOString();
  const json = Buffer.from(JSON.stringify({ format: 'smartqc-backup-v1', created_at: createdAt, workspace: ws || null, counts, tables }));
  const encrypted = encryptBuffer(json, passphrase);
  const name = `${FILE_PREFIX}${createdAt.replace(/[:.]/g, '-')}.bin`;

  const token = await googleAccessToken();
  const folderId = await ensureFolder(token);
  const file = await uploadFile(token, folderId, name, encrypted);
  console.log(`Đã tải lên Drive: ${file.name} (${file.size || encrypted.length} byte)`);

  // Xóa bản cũ, chỉ giữ KEEP bản mới nhất
  const all = await listBackups(token, folderId);
  const old = all.slice(KEEP);
  for (const f of old) await deleteFile(token, f.id);
  if (old.length) console.log(`Đã xóa ${old.length} bản cũ`);

  await writeStatus({
    ok: true, at: createdAt, file: file.name, drive_file_id: file.id,
    size_bytes: encrypted.length, counts, warnings, kept: Math.min(all.length, KEEP),
  });
  console.log(`XONG. smartqc_records = ${counts[REQUIRED_TABLE]} dòng. Đối chiếu với: select count(*) from public.smartqc_records;`);
}

main().catch(async (e) => {
  console.error('LỖI SAO LƯU:', e.message);
  await writeStatus({ ok: false, at: new Date().toISOString(), error: String(e.message).slice(0, 300) });
  process.exit(1);
});
