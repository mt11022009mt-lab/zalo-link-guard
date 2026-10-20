# Bot dọn link trong nhóm Zalo

Bot theo dõi các nhóm Zalo bạn chỉ định và gửi lệnh xóa tin có đường link ngoài danh sách tên miền được phép. Bot dùng `zca-js`, một thư viện **không chính thức** đăng nhập Zalo Web bằng QR. Tài khoản chạy bot cần là trưởng nhóm hoặc phó nhóm có quyền xóa tin và kick thành viên. Zalo có thể thay đổi giao diện web hoặc hạn chế tài khoản; không có bảo đảm bot sẽ hoạt động mãi.

Bot dùng `deleteMessage` để xóa tin. Bot chỉ dùng `removeUserFromGroup` khi QTV duyệt một hồ sơ đủ điều kiện hoặc chính QTV gửi lệnh `/kick @tag`. Mỗi lệnh kick chỉ có một ID thành viên. Hãy thử trong một nhóm nhỏ với `dryRun: true` trước khi bật thật.

## Cài và chạy trên Windows

Cần Node.js 18 trở lên. Mở PowerShell trong thư mục này:

```powershell
npm ci
npm start -- --list-groups
```

Mở `zalo-login-qr.png` xuất hiện trong thư mục, quét bằng tài khoản Zalo quản trị nhóm. Lệnh sẽ in ID và tên các nhóm. Bot xóa file QR sau khi đăng nhập. Không chia sẻ mã QR hay file đăng nhập.

Sao chép `config.example.json` thành `config.json`. Điền một hoặc nhiều ID nhóm vào `groupIds`. Thêm ID của những người được phép đăng link vào `trustedUserIds`, và tên miền được phép vào `allowedDomains`. Danh sách mặc định rỗng nên mọi link đều bị lọc. Tên miền trong danh sách cũng cho phép các tên miền con. `zalo.me` không cho phép `evilzalo.me`. `blockZaloLinks: true` chặn mọi link `zalo.me` và tên miền con, kể cả khi cấu hình cũ đã thêm `zalo.me` vào `allowedDomains`. Nếu muốn cho phép link Zalo thường, đặt `blockZaloLinks: false`; giữ `blockZaloGroupInvites: true` để vẫn chặn link mời nhóm `/g/...`.

`violationWindowHours` mặc định là `24`. Nhóm được giám sát cần có ít nhất một QTV là người thật, khác tài khoản chạy bot, để duyệt hồ sơ. Nếu bạn có **nhóm riêng chỉ dành cho QTV** mà tài khoản bot là thành viên, có thể thêm `"reviewGroupId": "ID_NHOM_QTV"` vào `config.json`. Bot sẽ gửi hồ sơ vào nhóm đó và nhắn riêng cho trưởng/phó nhóm. Nếu không có `reviewGroupId`, bot chỉ nhắn riêng cho các QTV. Zalo có thể từ chối tin nhắn riêng; bot sẽ ghi lỗi và giữ hồ sơ chờ duyệt.

```powershell
Copy-Item config.example.json config.json
notepad config.json
npm start
```

Ban đầu `dryRun` là `true`: bot chỉ ghi dòng `[XEM TRƯỚC]` khi thấy tin phù hợp; không xóa tin, gửi cảnh báo hay ghi lượt vi phạm. Lệnh kick cũng không kick khi `dryRun` bật. Gửi vài tin thử vào nhóm, kiểm tra log, rồi đổi `dryRun` thành `false` và chạy lại `npm start` để bật xử lý thật. Giữ cửa sổ PowerShell đang chạy; đóng cửa sổ sẽ dừng bot. Mỗi lần chạy cần quét QR lại.

Nếu có link mà bot không xử lý, chạy `npm start -- --debug` rồi gửi một tin thử từ **tài khoản khác**. Dòng `[DEBUG]` cho biết ID nhóm, loại tin, tên các trường dữ liệu và tên miền bot nhận được; bot không in nguyên nội dung tin. Xem thêm `trong_cấu_hình`, `tin_cậy`, `dryRun` và `quyết_định` để tìm lý do bị bỏ qua. Nếu có `[XEM TRƯỚC]`, đổi `dryRun` thành `false` và khởi động lại. Nếu có `[LỖI XÓA]`, tài khoản có thể thiếu quyền xóa tin của người khác hoặc API của thư viện đã thay đổi. Nếu không có `[DEBUG]`, kiểm tra kết nối Zalo và việc tài khoản đăng nhập đã ở trong nhóm.

## Quy tắc lọc

- Chỉ xử lý tin của người khác trong `groupIds`.
- Bỏ qua người trong `trustedUserIds`.
- Nhận dạng link dạng `https://`, `www.`, tên miền thường gặp, `hxxps://` và dấu chấm viết thành `[.]`.
- Nếu tin chứa ít nhất một tên miền ngoài `allowedDomains`, bot thử xóa **cả tin**. Vì vậy, hãy thêm các tên miền hợp lệ trước khi bật xóa.
- Mọi link `zalo.me` luôn bị lọc theo cấu hình mặc định, kể cả khi `allowedDomains` có `zalo.me`. Có thể điều chỉnh bằng `blockZaloLinks` và `blockZaloGroupInvites`.
- Bot đọc văn bản, chú thích ảnh/file, và tin xem trước link `chat.link` hoặc `chat.recommended`. Đường dẫn nội bộ của ảnh và file không bị coi là link quảng cáo. Link giấu trong ảnh hoặc mã QR cần OCR và hiện chưa được đọc.

## Cảnh báo, duyệt và kick

Mỗi **tin nhắn** có link bị cấm tính là một lần vi phạm, dù tin có nhiều link. Trong khoảng thời gian `violationWindowHours` (mặc định 24 giờ), bot cảnh báo ở lần 1, 2, 3. Lần thứ 4, bot tạo một hồ sơ gồm 4 tin vi phạm và gửi cho QTV. Bot **không tự kick** khi lập hồ sơ. Hồ sơ chờ duyệt thêm một khoảng thời gian bằng `violationWindowHours`; hết hạn thì không thể dùng để kick. Từ chối hồ sơ sẽ đặt lại bộ đếm của thành viên đó. Vì vậy, một tin link bị xóa vẫn chưa làm thành viên bị kick.

QTV của nhóm có thể gửi các lệnh sau trong nhóm gốc hoặc nhắn riêng cho tài khoản bot:

```text
/vipham                 Xem các hồ sơ chờ duyệt; bot gửi danh sách qua tin riêng
/duyetkick MA_HO_SO      Duyệt và kick đúng một thành viên trong hồ sơ
/tuchoikick MA_HO_SO     Từ chối hồ sơ, đặt lại bộ đếm
```

Lệnh trực tiếp dưới đây chỉ dùng **trong nhóm gốc**:

```text
/kick @TênThànhViên      QTV tag đúng một người và kick ngay
```

Bot xác minh người ra lệnh là trưởng/phó nhóm hiện tại qua Zalo trước mỗi lần kick. Bot không chấp nhận `@all`, nhiều tag, QTV, tài khoản bot, hoặc người trong `trustedUserIds` làm mục tiêu. Lệnh `/kick @tag` là hành động trực tiếp của QTV nên không đi qua hồ sơ vi phạm. Nếu QTV bấm `/duyetkick`, bot kiểm tra lại hồ sơ, quyền QTV và mục tiêu trước khi gọi API kick.

`moderation-state.json` lưu các lần vi phạm, link, hồ sơ và lịch sử kick trên máy chạy bot; file này không nằm trong ZIP hay Git. Giữ file này riêng tư. Đừng xóa file khi bot đang chạy. Nếu tin riêng tới QTV bị chặn, có thể cấu hình nhóm QTV riêng qua `reviewGroupId` để nhận hồ sơ.

Nếu nâng cấp từ bản bot trước: dừng bot, giữ lại `config.json` và `moderation-state.json`, thay các file mã nguồn bằng bản mới, chạy `npm ci`, rồi kiểm tra với `dryRun: true`. `blockZaloLinks`, `violationWindowHours` và `reviewGroupId` là tùy chọn; cấu hình cũ vẫn chạy. Bot không đọc hoặc điều khiển mã của một bot khác đang chạy trên máy.

Nếu lệnh xóa báo lỗi, kiểm tra quyền quản trị nhóm và tài khoản đăng nhập. Thư viện không chính thức có thể không tương thích khi Zalo cập nhật. Bot ghi ID nhóm, người gửi, tin và tên miền vào console để kiểm tra; file trạng thái lưu tối đa bốn link làm bằng chứng cho mỗi hồ sơ. Bot không lưu mật khẩu hoặc cookie đăng nhập.

## Kiểm tra

```powershell
npm test
```
