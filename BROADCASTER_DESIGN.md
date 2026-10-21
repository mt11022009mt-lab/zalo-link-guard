# Thiết kế module gửi link theo hàng đợi

Tài liệu này đặc tả module `src/broadcaster.js` cho bot đang dùng `zca-js` 2.2.0. Phạm vi gồm quyền điều khiển, lệnh qua tin nhắn, tham gia nhóm bằng link và gửi một chiến dịch tới các nhóm được chọn. `groupIds` hiện tại chỉ phục vụ moderation; module mới có danh sách nhóm và trạng thái lưu riêng.

## Ranh giới module

```text
api.listener → processMessage
                  ├─ broadcaster.handleCommand(message)  [chỉ tin trực tiếp, live]
                  └─ moderation.handleCommand(message)
                         ↓
                     checkMessage(message, config)

broadcaster.handleCommand → campaign queue → api.sendMessage
                          → join queue     → api.joinGroupLink
```

`src/bot.js` chỉ khởi tạo `createBroadcaster({ api, config, store, clock, random, log })`, gọi `handleCommand` trước moderation, rồi gọi `onConnected`/`onDisconnected` khi listener đổi trạng thái. Không sửa `checkMessage`, `createModeration` hay `config.groupIds`. Lệnh của broadcaster chỉ nhận trong tin riêng (`ThreadType.User`), không xử lý tin lịch sử, tin do chính bot gửi, tin từ nhóm hoặc nội dung không phải chuỗi. Một lệnh được nhận dạng phải trả `true` kể cả khi sai quyền/cú pháp, để không rơi tiếp vào luồng khác.

**Bật có chủ đích:** `broadcast.enabled` mặc định `false`. Nếu tắt, module không tạo worker hoặc gọi API gửi/join. `config.dryRun` hiện tại chỉ điều khiển moderation; broadcaster có `broadcast.dryRun` riêng, mặc định `true`.

## Cấu hình đề xuất

```json
{
  "broadcast": {
    "enabled": false,
    "dryRun": true,
    "broadcastOperatorIds": ["ID_TAI_KHOAN_1", "ID_TAI_KHOAN_2"],
    "initialGroupIds": [],
    "allowedLinkDomains": ["example.com"],
    "minDelaySeconds": 60,
    "maxDelaySeconds": 180,
    "maxGroupsPerCampaign": 30,
    "maxSendsPerDay": 30,
    "joinRetryLimit": 2,
    "sendRetryLimit": 2
  }
}
```

- Khi `enabled: true`, yêu cầu **đúng hai** ID chuỗi không rỗng, khác nhau. Không suy quyền từ `trustedUserIds`, quyền QTV nhóm hoặc `reviewGroupId`. So sánh `String(message.data.uidFrom)` với `Set` ID cấu hình; thiếu ID thì từ chối và không tiết lộ trạng thái chiến dịch. Quyền được kiểm tra lại ở **mỗi** lệnh.
- Chỉ nhận URL `https:` hợp lệ. `allowedLinkDomains` kiểm tra hostname chính xác hoặc subdomain có dấu chấm phân cách; không dùng so khớp chuỗi con. Cho phép danh sách rỗng nếu muốn mọi domain HTTPS, nhưng vẫn giới hạn kích thước URL/nội dung. Không dùng cấu hình `allowedDomains` của moderation.
- Giới hạn và khoảng chờ phải là số nguyên dương, `minDelaySeconds <= maxDelaySeconds`; kiểm tra cấu hình lúc khởi động. Giới hạn theo ngày dùng múi giờ cố định `Asia/Ho_Chi_Minh` hoặc UTC được ghi rõ trong trạng thái.
- `initialGroupIds` là danh sách nhóm nhận tin ban đầu. Nhóm do `/joinnhom` thêm được lưu riêng trong trạng thái bền vững. Không tự động thêm nhóm mới vào `groupIds` của moderation.

## Lệnh và phản hồi

| Lệnh trong tin riêng | Tác dụng | Phản hồi |
| --- | --- | --- |
| `/railink <URL> <mẫu nội dung>` | Tạo một chiến dịch, xếp các nhóm hiện có vào FIFO; nhóm join thành công trong lúc chạy được nối vào cuối hàng đợi | Mã chiến dịch, số nhóm, bản xem trước một biến thể, chế độ dry run và giờ gửi sớm nhất |
| `/stoprai` hoặc `/stoprai <mã>` | Dừng chiến dịch đang chạy hoặc đúng mã được nêu; hủy mục chưa gửi, cắt timer | Số mục đã gửi/chưa gửi; mục `sending` hoặc `unknown` được báo riêng |
| `/joinnhom <link mời Zalo>` | Xếp một link mời vào hàng đợi join, kiểm tra thông tin link và tư cách thành viên | Mã yêu cầu; kết quả sau khi xác minh là `joined`, `pending_approval` hoặc lỗi |
| `/trangthairai` | Xem chiến dịch đang chạy, số mục theo trạng thái, lần gửi kế tiếp và yêu cầu join gần đây | Bản tóm tắt ngắn; không in toàn bộ nội dung/link nhạy cảm |

Cú pháp mẫu: `/railink https://example.com/tin-tuc {Chào mọi người|Xin chào cả nhà}, xem thông tin tại link này.` Phần URL là token đầu sau lệnh; phần còn lại là mẫu nội dung bắt buộc, tối đa 1.000 ký tự. Nếu đã có chiến dịch `running`/`paused`, từ chối tạo thêm để tránh gửi hai luồng cùng lúc. Bắt buộc `broadcast.enabled` và hai ID hợp lệ trước khi nhận lệnh. Nếu `dryRun: true`, chạy cùng quy trình lập lịch/ghi trạng thái nhưng không gọi `sendMessage` hay `joinGroupLink`; phản hồi ghi rõ đây là mô phỏng.

Tin phản hồi lệnh dùng `api.sendMessage(text, senderId, ThreadType.User)`. Nếu phản hồi lỗi, chỉ ghi log rút gọn; tác vụ đã xếp vẫn tra được bằng `/trangthairai`. Chống xử lý lặp tin điều khiển bằng khóa `threadId:msgId` lưu có TTL trong trạng thái, không dựa vào `seenMessages` của moderation. Lệnh cũ từ lịch sử không được thực thi.

## Mẫu nội dung và lịch gửi

Mẫu chỉ hỗ trợ một tầng `{phương án A|phương án B}`; dấu ngoặc lồng, phương án rỗng, quá 10 cụm hoặc quá 5 phương án/cụm bị từ chối. Biên dịch/kiểm tra mẫu khi nhận lệnh; lưu mẫu gốc và một seed cho chiến dịch. Chọn phương án bằng PRNG có seed riêng cho từng mục để khởi động lại vẫn cho cùng biến thể. Luôn ghép URL chính xác một lần vào cuối nội dung nếu người dùng chưa đặt `{link}`; `{link}` chỉ được xuất hiện một lần. Không thay đổi URL, không tạo link rút gọn, không tạo câu chữ tự động ngoài các phương án người vận hành đã duyệt.

Một worker gửi tại một thời điểm. Mục đầu có thể bắt đầu ngay sau khi lưu bền vững; sau mỗi **lần thử gửi** đặt `nextAttemptAt = now + randomInt(60, 180) giây` theo cấu hình. Không gửi dồn khi bot khởi động lại: nếu mốc đã qua, chỉ xử lý một mục rồi tính lại khoảng chờ. Giới hạn theo ngày, giới hạn theo chiến dịch và lịch sử nhóm được kiểm tra trước mỗi lần gửi. Một nhóm chỉ có một mục trong một chiến dịch. Khoảng chờ là cơ chế điều tiết tải; không bảo đảm Zalo sẽ chấp nhận hoạt động hay tránh giới hạn tài khoản.

## Hàng đợi và lưu trạng thái

Tách `BroadcastStore` khỏi `ModerationState`. Lưu `broadcast-state.json` trong `STATE_DIR` hoặc bản ghi PostgreSQL riêng nếu có `DATABASE_URL`; thêm file và file tạm vào `.gitignore`. Khi `enabled: true` và chạy trên Render nhưng không có lưu trữ bền vững, dừng riêng module broadcast và ghi lỗi rõ ràng. Ghi atomically (file tạm + rename hoặc transaction/CAS trong PostgreSQL). Chỉ một worker được giữ lease; nhiều tiến trình cùng tài khoản phải tranh chấp lease trong store, nếu không giành được thì không gửi.

```js
{
  version: 1,
  revision: 12,
  lease: { owner: "instance-id", until: "ISO" },
  targetGroups: [{ groupId: "...", source: "config|join", joinedAt: "ISO" }],
  campaigns: [{
    id: "R20261021-AB12", operatorId: "...", url: "https://...",
    template: "...", seed: "...", status: "running|stopped|done|paused",
    createdAt: "ISO", nextAttemptAt: "ISO",
    items: [{ groupId: "...", status: "queued|sending|sent|failed|unknown|cancelled|simulated",
      attempts: 0, lastAttemptAt: null, sentAt: null, msgId: null, errorCode: null }]
  }],
  joinRequests: [{ id: "J...", link: "https://zalo.me/g/...", groupId: "...",
    status: "queued|joining|pending_approval|joined|failed|unknown", attempts: 0 }],
  processedCommandIds: [{ key: "thread:msg", seenAt: "ISO" }],
  dailyCounters: { "2026-10-21": 0 }
}
```

Chuyển `queued → sending` và lưu trước khi gọi API. Chỉ chuyển `sending → sent` nếu `sendMessage` trả `response.message.msgId`; lưu `msgId`. Trường hợp timeout/mất kết nối sau khi gọi API là `unknown`, **không tự gửi lại**, vì không biết Zalo đã nhận tin chưa. Khi khởi động lại, mọi mục còn `sending` chuyển thành `unknown`, chờ người vận hành kiểm tra bằng `/trangthairai`. `/stoprai` chỉ hủy mục `queued`, không thể thu hồi tin đã gửi. Giữ lịch sử và số đếm đủ lâu để chống gửi lặp sau restart; dọn bản ghi cũ theo retention cấu hình, không xóa chiến dịch chưa kết thúc.

## Quy trình tham gia nhóm

1. `/joinnhom` chỉ nhận URL mời `https://zalo.me/g/<mã>` sau khi chuẩn hóa, không theo redirect. Gọi `api.getGroupLinkInfo({ link })` để lấy `groupId` và tên, kiểm tra trùng với `targetGroups`, `initialGroupIds` và yêu cầu join khác. Không dùng tên nhóm làm khóa.
2. Lưu yêu cầu `queued`, rồi một join worker riêng xử lý với giới hạn thấp và không chạy song song. Gọi `api.joinGroupLink(link)` (bản 2.2.0 trả chuỗi rỗng nếu thành công; không có group ID trong kết quả).
3. Xác minh lại bằng `api.getAllGroups().gridVerMap[groupId]` và `api.getGroupInfo(groupId)`. Chỉ sau khi thấy tài khoản là thành viên, lưu `joined`, thêm vào `targetGroups`, rồi thêm **một** mục `queued` vào cuối chiến dịch đang `running`. Trước khi thêm phải kiểm tra giới hạn nhóm, giới hạn ngày và nhóm chưa có mục trong chiến dịch. Nếu chiến dịch đã dừng hoặc đạt giới hạn, nhóm vẫn ở `targetGroups` cho chiến dịch kế tiếp.
4. `ZaloApiError.code === 240`: lưu `pending_approval`, định kỳ kiểm tra tư cách thành viên; chưa thêm vào hàng gửi. Mã `178`: xác minh thành viên; nếu có thì coi là `joined`, nếu không thì `unknown`. Link hết hạn/không hợp lệ: `failed` không tự lặp vô hạn.

Nếu `joinGroupLink` trả thành công nhưng việc xác minh lỗi, giữ `unknown` và chỉ thử xác minh lại, không gọi join lần nữa ngay. Nhóm đã rời hoặc bị loại khỏi Zalo phải chuyển thành không đủ điều kiện, hủy mục `queued` của nhóm đó; việc tham gia lại cần lệnh `/joinnhom` mới. Không tự động thu thập link mời từ tin nhắn khác.

## Xử lý lỗi và trạng thái vận hành

| Tình huống | Xử lý |
| --- | --- |
| Mất kết nối listener | Tạm dừng worker; `onConnected` xác minh lease và tiếp tục theo `nextAttemptAt`; không gửi bù hàng loạt. |
| Lỗi xác thực, tài khoản bị giới hạn, API báo cấm | `paused`, không retry; thông báo cho hai operator qua tin riêng nếu có thể. |
| Lỗi trước khi gọi `sendMessage` (ví dụ xác minh nhóm) | Tối đa `sendRetryLimit`, backoff tăng dần, vẫn tôn trọng khoảng chờ và giới hạn ngày. |
| Timeout/lỗi sau khi đã gọi `sendMessage` | `unknown`, không retry tự động. |
| Nhóm không còn là thành viên hoặc không gửi được | `failed` cho riêng nhóm, tiếp tục mục sau khi chờ; không sửa `groupIds` moderation. |
| Ghi trạng thái lỗi | Dừng worker ngay; không gọi API khi chưa lưu được `sending`/`joining`. |
| Tắt bot/`/stoprai` giữa lúc gửi | Chờ request đang chạy hoàn tất hoặc đánh dấu `unknown`; không giả định đã hủy request Zalo. |

Log dùng mã chiến dịch, ID nhóm, trạng thái, mã lỗi và thời gian; tránh ghi toàn bộ URL, mẫu nội dung, cookie/session. `/trangthairai` nên báo rõ `unknown` để operator đối chiếu trước chiến dịch tiếp theo. Không bắt lỗi rồi âm thầm tiếp tục gửi.

## Điểm nối và tiêu chí kiểm thử

- Trong `src/bot.js`: xác thực `broadcast` độc lập; mở store sau login; tạo module; gọi `handleCommand` **chỉ khi `source === "live"`** và trước `moderation.handleCommand`; nối sự kiện connected/disconnected; đóng store khi tiến trình dừng.
- Trong `src/broadcaster.js`: xuất `createBroadcaster`; các hàm parse/validate/template/queue là hàm thuần hoặc phụ thuộc được tiêm để kiểm thử. Store riêng có kiểm soát revision và lease. Không import `moderation.js`, `policy.js` hay sửa state moderation.
- Trong `README.md` và `config.example.json`: ghi cấu hình, bốn lệnh, dry run, lưu trữ bền vững và việc Zalo có thể giới hạn tài khoản. Cấu hình cũ thiếu `broadcast` vẫn chạy như trước.
- Kiểm thử tối thiểu: người ngoài danh sách và người gửi trong nhóm không kích hoạt lệnh; hai operator hợp lệ; parse URL/template; nhóm trùng chỉ xếp một lần; `240` chờ duyệt, `178` xác minh thành viên; `stop` không gửi mục sau; restart giữa `sending` thành `unknown`; giới hạn/ngẫu nhiên bằng clock và random giả; moderation vẫn xử lý tin link của người khác như trước.
