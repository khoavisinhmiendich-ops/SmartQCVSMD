// Giải mã file sao lưu (tải từ Google Drive về máy), tùy chọn khôi phục vào Supabase
//
//   Giải mã ra file JSON để xem:
//     set BACKUP_PASSPHRASE=mat-khau-ma-hoa
//     node scripts/restore-from-backup.mjs duong-dan/smartqc-backup-xxx.bin
//
//   Khôi phục (ghi đè/gộp theo khóa chính) vào Supabase:
//     set RESTORE_CONFIRM=yes
//     + đặt SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_EMAIL, SUPABASE_PASSWORD
//     node scripts/restore-from-backup.mjs duong-dan/file.bin --apply
import fs from 'node:fs';
import { env, decryptBuffer, supabaseSession, upsertRows } from './lib.mjs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const apply = args.includes('--apply');

if (!file) {
  console.error('Cách dùng: node scripts/restore-from-backup.mjs <file.bin> [--apply]');
  process.exit(1);
}

const data = decryptBuffer(fs.readFileSync(file), env('BACKUP_PASSPHRASE'));
const backup = JSON.parse(data.toString('utf8'));
const out = `${file}.json`;
fs.writeFileSync(out, JSON.stringify(backup, null, 2));

console.log(`Bản sao lưu tạo lúc: ${backup.created_at}`);
for (const [t, rows] of Object.entries(backup.tables)) console.log(`  ${t}: ${rows.length} dòng`);
console.log(`Đã giải mã ra: ${out}`);

if (apply) {
  if (process.env.RESTORE_CONFIRM !== 'yes') {
    console.error('Chưa xác nhận. Đặt RESTORE_CONFIRM=yes để khôi phục vào Supabase.');
    process.exit(1);
  }
  const s = await supabaseSession();
  const order = ['smartqc_workspace_members', 'smartqc_shared_state', 'smartqc_records'];
  const names = [...order.filter((t) => backup.tables[t]), ...Object.keys(backup.tables).filter((t) => !order.includes(t))];
  for (const t of names) {
    const rows = backup.tables[t];
    for (let i = 0; i < rows.length; i += 500) await upsertRows(s, t, rows.slice(i, i + 500));
    console.log(`Đã khôi phục ${t}: ${rows.length} dòng`);
  }
}

