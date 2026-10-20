# Bot dọn link trong nhóm Zalo

Bot theo dõi các nhóm Zalo bạn chỉ định và gửi lệnh xóa tin có đường link ngoài danh sách tên miền được phép. Bot dùng `zca-js`, một thư viện **không chính thức** đăng nhập Zalo Web bằng QR. Tài khoản chạy bot cần là trưởng nhóm hoặc phó nhóm có quyền xóa tin của thành viên. Zalo có thể thay đổi giao diện web hoặc hạn chế tài khoản; không có bảo đảm bot sẽ hoạt động mãi.

Bot chỉ gọi API `deleteMessage` để xóa tin. Mã nguồn không gọi `removeUserFromGroup` hay API thay đổi thành viên nhóm. Hãy thử trong một nhóm nhỏ với `dryRun: true` trước khi bật xóa thật.

## Cài và chạy trên Windows

Cần Node.js 18 trở lên. Mở PowerShell trong thư mục này:

```powershell
npm ci
npm start -- --list-groups
```

Mở `zalo-login-qr.png` xuất hiện trong thư mục, quét bằng tài khoản Zalo quản trị nhóm. Lệnh sẽ in ID và tên các nhóm. Bot xóa file QR sau khi đăng nhập. Không chia sẻ mã QR hay file đăng nhập.

Sao chép `config.example.json` thành `config.json`. Điền một hoặc nhiều ID nhóm vào `groupIds`. Thêm ID của những người được phép đăng link vào `trustedUserIds`, và tên miền được phép vào `allowedDomains`. Danh sách mặc định rỗng nên mọi link đều bị lọc. Tên miền trong danh sách cũng cho phép các tên miền con. `zalo.me` không cho phép `evilzalo.me`. `blockZaloGroupInvites: true` vẫn chặn link mời nhóm `zalo.me/g/...` nếu bạn cho phép các link Zalo khác.

```powershell
Copy-Item config.example.json config.json
notepad config.json
npm start
```

Ban đầu `dryRun` là `true`: bot chỉ ghi dòng `[XEM TRƯỚC]` khi thấy tin phù hợp. Gửi vài tin thử vào nhóm, kiểm tra log, rồi đổi `dryRun` thành `false` và chạy lại `npm start` để bật xóa thật. Giữ cửa sổ PowerShell đang chạy; đóng cửa sổ sẽ dừng bot. Mỗi lần chạy cần quét QR lại.

Nếu có link mà bot không xử lý, chạy `npm start -- --debug` rồi gửi một tin thử từ **tài khoản khác**. Dòng `[DEBUG]` cho biết ID nhóm, loại tin và tên miền bot nhận được, không in nguyên nội dung tin. Nếu có `[XEM TRƯỚC]`, đổi `dryRun` thành `false` và khởi động lại. Nếu có `[LỖI XÓA]`, tài khoản có thể thiếu quyền xóa tin của người khác hoặc API của thư viện đã thay đổi. Nếu không có `[DEBUG]`, kiểm tra kết nối Zalo và việc tài khoản đăng nhập đã ở trong nhóm.

## Quy tắc lọc

- Chỉ xử lý tin của người khác trong `groupIds`.
- Bỏ qua người trong `trustedUserIds`.
- Nhận dạng link dạng `https://`, `www.`, tên miền thường gặp, `hxxps://` và dấu chấm viết thành `[.]`.
- Nếu tin chứa ít nhất một tên miền ngoài `allowedDomains`, bot thử xóa **cả tin**. Vì vậy, hãy thêm các tên miền hợp lệ trước khi bật xóa.
- Link mời nhóm `zalo.me/g/...` luôn bị lọc theo cấu hình mặc định, kể cả khi `allowedDomains` có `zalo.me`.
- Bot đọc văn bản và tin đính kèm được Zalo đánh dấu là link. Đường dẫn nội bộ của ảnh và file không bị coi là link quảng cáo. Link giấu trong ảnh, mã QR, hoặc cách viết lạ có thể lọt qua.

Nếu lệnh xóa báo lỗi, kiểm tra quyền quản trị nhóm và tài khoản đăng nhập. Thư viện không chính thức có thể không tương thích khi Zalo cập nhật. Bot ghi ID nhóm, người gửi, tin và tên miền vào console để kiểm tra; nó không lưu lịch sử tin nhắn hay mật khẩu.

## Kiểm tra

```powershell
npm test
```
