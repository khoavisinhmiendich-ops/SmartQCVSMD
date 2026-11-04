// Lấy refresh token Google Drive bằng device flow
const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Thiếu GOOGLE_CLIENT_ID hoặc GOOGLE_CLIENT_SECRET');
  process.exit(1);
}

const form = (o) => new URLSearchParams(o);
const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };

const dcRes = await fetch('https://oauth2.googleapis.com/device/code', {
  method: 'POST',
  headers,
  body: form({ client_id: clientId, scope: 'https://www.googleapis.com/auth/drive.file' }),
});
const dc = await dcRes.json();
if (!dcRes.ok) {
  console.error('Lỗi xin mã:', dc);
  process.exit(1);
}

console.log('\n1) Mở link:', dc.verification_url);
console.log('2) Nhập mã :', dc.user_code);
console.log('3) Đăng nhập đúng tài khoản Google rồi bấm Cho phép.\nĐang chờ...\n');

let wait = (dc.interval || 5) * 1000;
const deadline = Date.now() + dc.expires_in * 1000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, wait));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers,
    body: form({
      client_id: clientId,
      client_secret: clientSecret,
      device_code: dc.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });
  const t = await res.json();
  if (t.refresh_token) {
    console.log('GOOGLE_REFRESH_TOKEN =', t.refresh_token);
    process.exit(0);
  }
  if (t.error === 'authorization_pending') continue;
  if (t.error === 'slow_down') { wait += 5000; continue; }
  console.error('Lỗi:', t.error, t.error_description || '');
  process.exit(1);
}
console.error('Hết thời gian chờ, chạy lại script.');
process.exit(1);
