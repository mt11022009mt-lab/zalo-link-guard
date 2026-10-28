# 🛡️ Zalo Link Guard & Group Guardian (v2.0.0)

Hệ thống bot tự động quản lý nhóm Zalo chuyên nghiệp: **Tự động lọc link spam, chặn ảnh rác, xử lý vi phạm âm thầm và kick thành viên quấy phá 24/7.**

---

## 🌟 Tính Năng Nổi Bật

### 1. 🧹 Lọc Link & Chặn Ảnh Spam Siêu Tốc
- **Quét sạch link lạ:** Tự động phát hiện và xóa mọi đường link không được phép (bao gồm link web, link mời nhóm `zalo.me/g/...`, link rút gọn, link ẩn hoặc tin nhắn dạng Link Preview Card).
- **Chặn ảnh & Album spam:** Tùy chọn `blockImages: true` giúp ngăn chặn triệt để tình trạng spam ảnh vào box chat.
- **Cơ chế xóa 2 lớp (Dual Fallback):** Ưu tiên xóa tin nhắn đối với mọi người (`deleteMessage`), nếu gặp lỗi sẽ tự động chuyển sang thu hồi tin nhắn (`undo`), đảm bảo tỷ lệ dọn dẹp thành công cao nhất.

### 2. 🤫 Chế Độ Kiểm Duyệt Âm Thầm (Silent Moderation)
- **Box chat luôn sạch sẽ:** Bot xóa link/ảnh và tính điểm vi phạm hoàn toàn trong im lặng, **tuyệt đối không gửi tin nhắn cảnh báo rác vào nhóm**.
- **Chống giới hạn Zalo (Anti-Rate Limit):** Triệt tiêu hoàn toàn nguy cơ tài khoản bot bị Zalo phạt rate-limit (*"Đạt giới hạn rồi"*) do gửi tin nhắn tag người lạ quá nhiều.

### 3. ⚖️ Đếm Vi Phạm & Tự Động Kick Thành Viên (Auto-Kick)
- **Tự động tính điểm:** Mặc định vi phạm 3 lần trong vòng 24 giờ sẽ bị **tự động kick khỏi nhóm**.
- **Miễn trừ an toàn:** Trưởng nhóm, Phó nhóm và danh sách ID tin cậy (`trustedUserIds`) không bao giờ bị xóa tin hay kick nhầm.

### 4. 🔄 Tự Động Kích Hoạt Bảo Vệ Mọi Nhóm Bot Làm QTV
- Không cần sửa cấu hình thủ công mỗi khi có nhóm mới.
- Bất kỳ nhóm Zalo nào bot được cấp quyền **Phó nhóm hoặc Trưởng nhóm**, bot sẽ **tự động nạp vào danh sách bảo vệ** ngay lập tức.

### 5. 🛠️ Bộ Lệnh Quản Trị Viên (Dành Cho QTV)
| Lệnh | Cú pháp | Tác dụng |
| :--- | :--- | :--- |
| `/vipham` | `/vipham` | Xem danh sách thành viên đang có điểm vi phạm trong nhóm |
| `/kick` | `/kick @thành_viên` | Kick trực tiếp thành viên vi phạm khỏi nhóm |
| `/tha` | `/tha @thành_viên` | Xóa toàn bộ điểm vi phạm cho thành viên (hoặc `/xoavipham`) |
| `/mute` | `/mute @thành_viên [thời_gian]` | Cấm chat thành viên trong nhóm (tự động xóa tin tức thì) |
| `/unmute` | `/unmute @thành_viên` | Gỡ cấm chat cho thành viên trong nhóm |
| `/dsmute` | `/dsmute` | Xem danh sách thành viên đang bị cấm chat |
| `/khoaqtv` | `/khoaqtv [on/off]` | Khóa quyền QTV tuyệt đối (chỉ người trong whitelist mới dùng được bot) |
| `/themuser` | `/themuser @tag/<UID>` | Cấp quyền dùng bot cho người dùng/bot |
| `/xoauser` | `/xoauser @tag/<UID>` | Thu hồi quyền sử dụng bot |
| `/dsuser` | `/dsuser` | Xem danh sách người dùng được cấp quyền dùng bot |
| `/status` | `/status` hoặc `/botinfo` | Xem phiên bản, trạng thái hoạt động và số nhóm bot đang bảo vệ |
| `/help` | `/help` | Xem danh sách các lệnh quản trị |
| `/myid` | `/myid` | Xem UID Zalo của bản thân |

### 6. 💛 Dịch Vụ Up Locket Gold Tự Động
| Lệnh | Đối tượng | Tác dụng |
| :--- | :--- | :--- |
| `locketgold` hoặc `/locketgold` | Khách hàng | Khách nhắn cho bot (trong nhóm hoặc DM riêng), bot gửi ngay UID Zalo của khách để chuyển cho Admin duyệt |
| `/dslocket` | Quản trị viên | Xem danh sách khách hàng đang chờ duyệt nâng cấp Locket Gold |
| `/duyetlocket <UID>` | Quản trị viên | Duyệt đơn cho khách; bot tự động gửi video hướng dẫn và link cấu hình (hướng dẫn khách sao chép link) qua tin nhắn riêng |
| `/tuchoilocket <UID>` | Quản trị viên | Từ chối đơn đăng ký Locket Gold của khách |
| `/setmodel <link>` | Quản trị viên | Cập nhật link cấu hình Locket Gold để khách sao chép (hoặc `/setmodel default` để dùng link hệ thống) |
| `/xemmodel` | Quản trị viên | Xem link cấu hình Locket Gold hiện tại |
| `/setvideo <link>` | Quản trị viên | Cập nhật link video hướng dẫn online (hoặc `/setvideo default`) |
| `/xemvideo` | Quản trị viên | Xem link video và kiểm tra trạng thái file video hiện tại |
| `/sethuongdan <nội dung>` | Quản trị viên | Cập nhật nội dung văn bản hướng dẫn Locket Gold gửi kèm cho khách |
| `/xemhuongdan` | Quản trị viên | Xem nội dung hướng dẫn Locket Gold hiện tại |
| `/resethuongdan` | Quản trị viên | Đặt lại nội dung hướng dẫn về mẫu chuẩn ban đầu |

---

## ⚙️ Cấu Hình (`config.json`)

```json
{
  "groupIds": [
    "8623577123597443914",
    "908709376055683451"
  ],
  "trustedUserIds": [
    "632992889887914287",
    "6314752836073016389",
    "445532160147034569"
  ],
  "allowedDomains": ["zalo.me"],
  "blockZaloLinks": true,
  "blockZaloGroupInvites": true,
  "blockImages": true,
  "silentModeration": true,
  "maxViolations": 3,
  "autoKick": true,
  "violationWindowHours": 24,
  "historySweepSeconds": 60,
  "dryRun": false
}
```

### Giải thích các tham số:
* `groupIds`: Danh sách ID các nhóm cần bảo vệ (bot cũng sẽ tự động bảo vệ thêm bất kỳ nhóm nào bot là QTV).
* `trustedUserIds`: Danh sách UID các tài khoản được miễn trừ kiểm duyệt (chủ bot, admin dự phòng).
* `allowedDomains`: Danh sách tên miền được phép gửi vào nhóm.
* `blockZaloLinks`: Chặn cả các đường link Zalo khác ngoài link cho phép.
* `blockZaloGroupInvites`: Chặn link mời nhóm `zalo.me/g/...` (chống cướp mem / spam nhóm).
* `blockImages`: `true` để xóa ảnh và album ảnh của thành viên thường.
* `silentModeration`: `true` để xóa và kick âm thầm không spam thông báo vào box chat.
* `maxViolations`: Số lần vi phạm tối đa trước khi bị kick (mặc định 3).
* `autoKick`: `true` để tự động kick khi đủ số lần vi phạm.
* `violationWindowHours`: Khoảng thời gian tính điểm vi phạm (mặc định 24 giờ, sau 24h điểm tự xóa).
* `dryRun`: `false` để thực thi thật; `true` để chỉ chạy thử nghiệm không xóa thật.

---

## 🌐 Trang Web Dashboard & Chẩn Đoán Trực Tiếp
Khi chạy trên Cloud (Render / VPS):
* **Trang chủ (`/`):** Giao diện web hiển thị trạng thái bot trực quan, số nhóm đang bảo vệ và thời gian hoạt động.
* **Trang chẩn đoán (`/debug`):** Xem chi tiết cấu hình hiện tại và 50 log kiểm duyệt gần nhất theo thời gian thực.
* **Health check (`/ping`):** Phục vụ UptimeRobot hoặc Render health check giữ bot luôn online 24/7.

---

## 🚀 Triển Khai Lên Render (24/7)

1. **GitHub:** Đẩy code lên repository cá nhân của bạn.
2. **Render Dashboard:** Tạo một **Web Service** mới trỏ vào repo GitHub.
3. **Cấu hình Environment Variables:**
   - `SESSION_JSON`: Chuỗi JSON thông tin đăng nhập tài khoản Zalo.
   - `CONFIG_JSON`: Toàn bộ nội dung file `config.json`.
   - `DATABASE_URL`: (Tùy chọn) Chuỗi kết nối PostgreSQL để lưu điểm vi phạm vĩnh viễn qua các lần khởi động lại.
4. **Deploy & Hoàn tất:** Chọn **Manual Deploy** ➔ **Deploy latest commit**. Bot sẽ tự động kết nối Zalo và bảo vệ các nhóm ngay lập tức!
