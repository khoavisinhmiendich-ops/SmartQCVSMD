// Lấy refresh token Google Drive bằng device flow (chạy 1 lần trên máy tính)
// Cần: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (OAuth client loại "TVs and Limited Input devices")
const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
if (!clientId || !clientSecret) {
  console.error('Thiếu GOOGLE_CLIENT_ID hoặc GOOGLE_CLIENT_SECRET');
  process.exit(1);
}

const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };

const dcRes = await fetch('https://oauth2.googleapis.com/device/code', {
  method: 'POST',
  headers,
  body: new URLSearchParams({ client_id: clientId, scope: 'https://www.googleapis.com/auth/drive.file' }),
});
const dc = await dcRes.json();
if (!dcRes.ok) {
  console.error('Lỗi xin mã:', dc);
  process.exit(1);
}

console.log('\n1) Mở link:', dc.verification_url);
console.log('2) Nhập mã :', dc.user_code);
console.log('3) Đăng nhập đúng tài khoản Google sẽ chứa file sao lưu, rồi bấm Cho phép.');
console.log('Đang chờ bạn cho phép...\n');

let waitMs = (dc.interval || 5) * 1000;
const deadline = Date.now() + dc.expires_in * 1000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, waitMs));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers,
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      device_code: dc.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });
  const t = await res.json();
  if (t.refresh_token) {
    console.log('GOOGLE_REFRESH_TOKEN =', t.refresh_token);
    console.log('\nCopy chuỗi trên (không gồm "GOOGLE_REFRESH_TOKEN =") và dán vào GitHub Secrets.');
    process.exit(0);
  }
  if (t.error === 'authorization_pending') continue;
  if (t.error === 'slow_down') { waitMs += 5000; continue; }
  console.error('Lỗi:', t.error, t.error_description || '');
  process.exit(1);
}
console.error('Hết thời gian chờ, hãy chạy lại script.');
process.exit(1);
