# Bot dọn link trong nhóm Zalo

## Bản 1.12.3: giữ bộ đếm vi phạm qua lần khởi động lại

Trên Render, bot **dừng lúc khởi động** nếu chưa đặt `DATABASE_URL` hoặc `STATE_DIR`. Trước đây bot tiếp tục chạy với file cục bộ và âm thầm mất lượt vi phạm khi Render khởi động lại. Hãy cấu hình một nơi lưu bền vững theo hướng dẫn bên dưới **trước khi triển khai bản này**. Chỉ đặt `STATE_DIR` là chưa đủ: đường dẫn đó phải là mount path của Render Persistent Disk. Nếu không có nơi lưu, bot dừng và sẽ không lọc tin cho đến khi cấu hình xong.

Lúc khởi động, log hiển thị loại lưu trữ và `đã_khôi_phục=N lượt còn hiệu lực`. Mỗi lần ghi thành công, log có dòng `[ĐẾM VI PHẠM]` với số lượt hiện tại. Nếu PostgreSQL lỗi ghi một lần rồi phục hồi, lần lưu tiếp theo có thể tiếp tục và ghi lại toàn bộ các lượt còn trong bộ nhớ. Những lượt đã mất trước khi có nơi lưu bền vững không thể tự khôi phục.

## Bản 1.12.2: bổ sung nhận dạng ảnh và log chẩn đoán

Bot nhận dạng thêm tin ảnh khi Zalo gửi loại tin chung nhưng dữ liệu đính kèm có `photoId`, `fileType: image` hoặc thông tin ảnh tương đương. GIF vẫn được cho phép nếu không có link cấm. Bot in `[BOT] phiên_bản=1.12.2` lúc chạy; khi dùng `--debug`, log cho biết tin có `cliMsgId` hay không, bot nhận dạng ảnh hay link, và quyết định xử lý. Nếu tin thiếu ID để xóa, bot ghi `[THIẾU ID]` kèm loại tin. Không cần gửi nội dung ảnh, QR hoặc phiên đăng nhập để chẩn đoán.

Nếu ảnh vẫn lọt sau khi triển khai, đối chiếu **cùng ID tin** trong `[DEBUG]` với `[API XÓA TRẢ VỀ]` hoặc `[LỖI XÓA]`. Không có `[DEBUG]` nghĩa là listener/lịch sử không đưa tin đó tới bot; `ảnh=false` và `link=không_thấy` nghĩa là payload khác các dạng đã nhận; có lệnh xóa nhưng ảnh vẫn còn sau khi tải lại Zalo cần kiểm tra API và quyền xóa. Chỉ log của chính tin đó mới xác định được nhánh cần sửa tiếp.

## Bản 1.12.1: cho phép GIF

GIF của thành viên thường được giữ lại. Bot vẫn chặn ảnh tĩnh và album ảnh; QTV vẫn được gửi ảnh. Nếu caption GIF có link bị cấm, quy tắc lọc link vẫn xử lý tin đó như trước.

## Bản 1.12.0: chặn ảnh của thành viên thường

Bot xóa tin ảnh và album ảnh do **thành viên thường** gửi trong các nhóm được quản lý, kể cả ảnh không có link. Trưởng nhóm, phó nhóm và người trong `trustedUserIds` vẫn gửi ảnh được. Bot xác minh quyền QTV hiện tại trước khi xóa; nếu không xác minh được quyền, bot bỏ qua tin để tránh xóa nhầm ảnh của QTV. GIF, video, sticker và file thường không bị quy tắc ảnh chặn trong bản hiện tại.

Thêm `"blockImages": true` vào `config.json` nếu muốn ghi rõ cấu hình. Bản này mặc định bật chặn ảnh ngay cả khi `config.json` cũ chưa có khóa đó; đặt `false` để tắt. Ảnh thường chỉ bị xóa, **không cộng số lần vi phạm link, không gửi cảnh báo link và không lập hồ sơ kick**. Ảnh có caption chứa link cấm vẫn được tính một lần vi phạm link như trước. `dryRun: true` chỉ ghi log xem trước, không xóa. Sau khi cập nhật, chạy `npm ci` và khởi động lại bot; xem `[CHẶN ẢNH] blockImages=true` trong log.

## Bản 1.11.0: caption ảnh và lưu số lần vi phạm

Bot đọc thêm caption nằm trong `params`/`data.params` dạng JSON của tin ảnh. Bot chỉ quét các trường chữ do người gửi viết; URL CDN của ảnh không bị tính là link quảng cáo. Nếu vẫn thấy ảnh có caption link lọt, chạy bản mới với `--debug` và gửi **dòng `[DEBUG]` của chính tin đó** cùng dòng `[API XÓA TRẢ VỀ]` hoặc `[LỖI XÓA]` nếu có. Có link trong ảnh chụp màn hình chưa đủ để biết sự kiện ảnh đã tới bot hay API xóa có hiệu lực. Không gửi QR, cookie hoặc `SESSION_JSON`.

`SESSION_JSON` chỉ giữ đăng nhập Zalo. Để lượt vi phạm và hồ sơ không bị đặt lại khi Render khởi động lại, chọn **một** nơi lưu:

1. **PostgreSQL:** tạo Render Postgres, sao chép **Internal Database URL** vào biến môi trường `DATABASE_URL` của dịch vụ bot, cùng vùng Render với dịch vụ. Bot tạo bảng `zalo_link_guard_state` và dùng lại dữ liệu sau mỗi lần khởi động. Giữ URL này riêng tư. Dùng một tiến trình bot cho một cơ sở dữ liệu; nếu hai tiến trình cùng ghi, bot sẽ từ chối ghi đè trạng thái cũ. [Cách tạo và kết nối Render Postgres](https://render.com/docs/postgresql-creating-connecting).
2. **Ổ đĩa bền vững:** gắn Render Persistent Disk vào dịch vụ trả phí, ví dụ mount path `/var/data`, rồi đặt biến môi trường `STATE_DIR=/var/data`. Bot lưu `moderation-state.json` trên ổ này. Chỉ đặt biến `STATE_DIR` mà chưa gắn disk **không** bảo đảm dữ liệu còn sau khi restart. [Render Persistent Disks](https://render.com/docs/disks).

Nếu có cả hai biến, bot ưu tiên `DATABASE_URL`. Khi chưa có cả hai, bản 1.12.3 dừng trên Render và báo lỗi `[LƯU VI PHẠM]`; chạy trên máy cá nhân vẫn có thể dùng file cục bộ. Render Postgres gói miễn phí hết hạn sau 30 ngày, nên cần nâng cấp hoặc chuyển dữ liệu trước hạn nếu muốn lưu lâu dài. [Giới hạn gói miễn phí Render](https://render.com/docs/free). Sau khi deploy, tìm dòng `[LƯU VI PHẠM] PostgreSQL (DATABASE_URL)` hoặc `file trong STATE_DIR` cùng dòng `đã_khôi_phục=N` trong log. Những lượt đã mất trước khi gắn nơi lưu bền vững không thể tự khôi phục; bot chỉ có thể nhập `moderation-state.json` cũ nếu file đó còn trong thư mục chạy lúc khởi động lần đầu với database/disk.

## Bản 1.10.0

Tin có link do **trưởng nhóm hoặc phó nhóm** gửi được bỏ qua hoàn toàn: không xóa, không cảnh báo, không cộng vi phạm và không lập hồ sơ kick. Bot xác minh quyền hiện tại qua `getGroupInfo` trước khi xử lý mỗi tin có link; nếu không xác minh được thì bỏ qua tin đó và ghi `[KIỂM TRA QTV]` để tránh xử lý nhầm QTV. Người trong `trustedUserIds` vẫn được miễn như trước.

Nếu API đọc lịch sử nhóm cũ trả 404, bot thử chuyển sang endpoint lịch sử cloud bằng hook `custom` của `zca-js`. Bản sửa này dựa trên [PR #370 của thư viện](https://github.com/RFS-ADRENO/zca-js/pull/370/files), hiện chưa được phát hành chính thức; cần xem log sau khi triển khai để xác nhận trên cộng đồng của bạn. Listener cũng bật chế độ kết nối lại và ghi các sự kiện `[KẾT NỐI]`. Nếu cả hai đường lịch sử đều lỗi, bot chỉ còn nhận tin trực tiếp và vẫn có thể bỏ lỡ tin.

Sau khi cập nhật, dừng tiến trình cũ và chạy bản mới. Giữ nguyên `config.json`, `moderation-state.json` và `SESSION_JSON`; không phải quét QR lại khi phiên còn hiệu lực. Chạy `npm start -- --debug` để xem bot nhận và quyết định thế nào với một tin ảnh có caption chứa link. Dòng `[API XÓA TRẢ VỀ]` của một tin khác không xác nhận tin ảnh đó đã được xử lý.

## Bản 1.9.0

Bot có thể đăng nhập bằng biến môi trường `SESSION_JSON`. Sau lần quét QR thành công trên máy cá nhân, bot tự lưu thông tin đăng nhập vào `zalo-session.json` trong thư mục chạy. File này được bỏ qua bởi Git; không in cookie lên console. Trên Render, bot yêu cầu `SESSION_JSON` và dừng với thông báo rõ ràng nếu biến bị thiếu, sai định dạng hoặc phiên bị Zalo từ chối. Phiên có thể hết hạn hoặc bị thu hồi; khi đó phải tạo phiên mới bằng QR. Tính năng này không bảo đảm tránh bị hạn chế tài khoản.

### Dùng trên Render

1. Trên máy cá nhân, cập nhật bản này, chạy `npm ci` rồi `npm start -- --list-groups`. Quét QR một lần. Bot tạo file `zalo-session.json` trong thư mục chạy; mở file bằng trình soạn thảo văn bản và sao chép **toàn bộ một dòng JSON**.
2. Trong Render Dashboard của dịch vụ bot, vào **Environment → Add Environment Variable**: Key `SESSION_JSON`, Value là một dòng JSON vừa sao chép. Chọn **Save and deploy**. Dịch vụ cũng cần có `config.json` hợp lệ; có thể cấp qua Render Secret File tên `config.json`.
3. Xem log Render: dòng `Đã đăng nhập bằng SESSION_JSON.` xác nhận bot đã nạp phiên. Nếu phiên hết hạn, chạy lại bước 1 trên máy cá nhân và thay giá trị biến môi trường. Không dán JSON vào GitHub, chat, issue hay log.

Nếu đặt `SESSION_JSON` ngay trên máy cá nhân, bot cũng dùng lại phiên mà không hiện QR. File `zalo-session.json` là thông tin đăng nhập nhạy cảm; giữ riêng tư và xóa bản sao không còn dùng. Đăng nhập bằng phiên chỉ hoạt động khi Zalo vẫn chấp nhận cookie, IMEI và user agent đã lưu.

## Bản 1.8.0

Bot đọc `description`/`desc` của tin kèm ảnh dù Zalo gửi loại tin khác `chat.photo`, và đọc được trường hợp dữ liệu ảnh là JSON dạng chữ. URL ảnh từ CDN trong `href`/`url` vẫn không bị xem là link quảng cáo. Tin chưa thấy link ở sự kiện trực tiếp không bị đánh dấu đã xử lý, để lần đọc lịch sử có thể kiểm tra lại caption. Nếu Zalo báo lỗi xóa, bot vẫn ghi đúng một lượt vi phạm cho tin đó và có thể thử xóa lại khi quét lịch sử.

Sau khi thay mã nguồn, **dừng tiến trình cũ rồi chạy bản mới**; chỉ thay file ZIP trên máy sẽ không cập nhật bot đang chạy. Giữ lại `config.json` và `moderation-state.json`. Nếu cùng một tin vẫn lọt, chạy `npm start -- --debug` và xem các dòng `[DEBUG]`, `[API XÓA TRẢ VỀ]` hoặc `[LỖI XÓA]` lúc gửi tin thử. Không chia sẻ QR hoặc cookie đăng nhập.

Bot theo dõi các nhóm Zalo bạn chỉ định và gửi lệnh xóa tin có đường link ngoài danh sách tên miền được phép. Bot dùng `zca-js`, một thư viện **không chính thức** đăng nhập Zalo Web bằng QR. Tài khoản chạy bot cần là trưởng nhóm hoặc phó nhóm có quyền xóa tin và kick thành viên. Zalo có thể thay đổi giao diện web hoặc hạn chế tài khoản; không có bảo đảm bot sẽ hoạt động mãi.

Bot dùng `deleteMessage` để xóa tin. Bot chỉ dùng `removeUserFromGroup` khi QTV duyệt một hồ sơ đủ điều kiện hoặc chính QTV gửi lệnh `/kick @tag`. Mỗi lệnh kick chỉ có một ID thành viên. Hãy thử trong một nhóm nhỏ với `dryRun: true` trước khi bật thật.

## Cài và chạy trên Windows

Cần Node.js 18 trở lên. Mở PowerShell trong thư mục này:

```powershell
npm ci
npm start -- --list-groups
```

Nếu chưa có `SESSION_JSON`, mở `zalo-login-qr.png` xuất hiện trong thư mục và quét bằng tài khoản Zalo quản trị nhóm. Lệnh sẽ in ID và tên các nhóm. Bot xóa file QR sau khi đăng nhập và lưu phiên vào `zalo-session.json`. Không chia sẻ mã QR hay file phiên.

Sao chép `config.example.json` thành `config.json`. Điền một hoặc nhiều ID nhóm vào `groupIds`. Thêm ID của những người được phép đăng link vào `trustedUserIds`, và tên miền được phép vào `allowedDomains`. Danh sách mặc định rỗng nên mọi link đều bị lọc. Tên miền trong danh sách cũng cho phép các tên miền con. `zalo.me` không cho phép `evilzalo.me`. `blockZaloLinks: true` chặn mọi link `zalo.me` và tên miền con, kể cả khi cấu hình cũ đã thêm `zalo.me` vào `allowedDomains`. Nếu muốn cho phép link Zalo thường, đặt `blockZaloLinks: false`; giữ `blockZaloGroupInvites: true` để vẫn chặn link mời nhóm `/g/...`.

`violationWindowHours` mặc định là `24`. `historySweepSeconds` mặc định là `60`: mỗi phút bot đọc 50 tin gần nhất trong mỗi nhóm để nhặt tin **mới từ khi bot khởi động** mà kết nối nhận tin đã lỡ. Nếu endpoint cũ báo 404, bot thử endpoint lịch sử cloud. Đặt `0` để tắt; giá trị khác phải từ `30` đến `300` giây. Bot không quét tin cũ trước lúc khởi động. Nhóm quá nhiều tin trong một phút vẫn có thể vượt quá 50 tin gần nhất. Nhóm được giám sát cần có ít nhất một QTV là người thật, khác tài khoản chạy bot, để duyệt hồ sơ. Nếu bạn có **nhóm riêng chỉ dành cho QTV** mà tài khoản bot là thành viên, có thể thêm `"reviewGroupId": "ID_NHOM_QTV"` vào `config.json`. Bot sẽ gửi hồ sơ vào nhóm đó và nhắn riêng cho trưởng/phó nhóm. Nếu không có `reviewGroupId`, bot chỉ nhắn riêng cho các QTV. Zalo có thể từ chối tin nhắn riêng; bot sẽ ghi lỗi và giữ hồ sơ chờ duyệt.

```powershell
Copy-Item config.example.json config.json
notepad config.json
npm start
```

Ban đầu `dryRun` là `true`: bot chỉ ghi dòng `[XEM TRƯỚC]` khi thấy tin phù hợp; không xóa tin, gửi cảnh báo hay ghi lượt vi phạm. Lệnh kick cũng không kick khi `dryRun` bật. Lúc khởi động bot in cảnh báo `[CHỈ XEM TRƯỚC]` nếu chế độ này còn bật, và in `[KIỂM TRA NHÓM]` gồm tên nhóm và quyền QTV của tài khoản bot. Gửi vài tin thử vào nhóm, kiểm tra log, rồi đổi `dryRun` thành `false` và chạy lại `npm start` để bật xử lý thật. Giữ cửa sổ PowerShell đang chạy; đóng cửa sổ sẽ dừng bot. Muốn bỏ qua QR trên máy cá nhân, đặt biến môi trường `SESSION_JSON` bằng nội dung file phiên đã lưu.

Nếu có link mà bot không xử lý, chạy `npm start -- --debug` rồi gửi một tin thử từ **tài khoản khác**. Dòng `[DEBUG]` cho biết `nguồn=live` hoặc `nguồn=history`, ID nhóm, loại tin, tên các trường dữ liệu và tên miền bot nhận được; bot không in nguyên nội dung tin. Xem thêm `trong_cấu_hình`, `tin_cậy`, `dryRun` và `quyết_định` để tìm lý do bị bỏ qua. Nếu có `[XEM TRƯỚC]`, đổi `dryRun` thành `false` và khởi động lại. Nếu có `[LỖI XÓA]`, tài khoản có thể thiếu quyền xóa tin của người khác hoặc API của thư viện đã thay đổi. `[API XÓA TRẢ VỀ]` chỉ cho biết thư viện đã nhận phản hồi; nếu tin còn hiển thị sau khi tải lại Zalo, kiểm tra quyền QTV và trạng thái thực tế của tin. Nếu không có `[DEBUG]` sau hơn một phút, kiểm tra `[KIỂM TRA LỊCH SỬ]`, kết nối Zalo, bot còn chạy và tài khoản đăng nhập đã ở trong nhóm.

## Quy tắc lọc

- Chỉ xử lý tin của người khác trong `groupIds`.
- Bỏ qua người trong `trustedUserIds`.
- Bỏ qua trưởng/phó nhóm theo quyền hiện tại trên Zalo, kể cả khi họ gửi link; không xóa hoặc cảnh báo tin của họ.
- Nhận dạng link dạng `https://`, `www.`, tên miền thường gặp, `hxxps://` và dấu chấm viết thành `[.]`. Link `zalo.me/g/` bị xuống dòng trước mã mời cũng được ghép lại.
- Nếu tin chứa ít nhất một tên miền ngoài `allowedDomains`, bot thử xóa **cả tin**. Vì vậy, hãy thêm các tên miền hợp lệ trước khi bật xóa.
- Mọi link `zalo.me` luôn bị lọc theo cấu hình mặc định, kể cả khi `allowedDomains` có `zalo.me`. Có thể điều chỉnh bằng `blockZaloLinks` và `blockZaloGroupInvites`.
- Bot đọc văn bản, một số dạng nội dung văn bản được Zalo gói trong object, chú thích ảnh/video/file (gồm trường `description` của tin `chat.photo`), và tin xem trước link `chat.link` hoặc `chat.recommended`. Đường dẫn nội bộ của ảnh và file không bị coi là link quảng cáo. Link được in bên trong ảnh hoặc mã QR cần OCR và hiện chưa được đọc.

## Cảnh báo, duyệt và kick

Mỗi **tin nhắn** có link bị cấm tính là một lần vi phạm, dù tin có nhiều link. Trong khoảng thời gian `violationWindowHours` (mặc định 24 giờ), bot cảnh báo ở lần 1/4, 2/4, 3/4. Lần thứ 4, bot tạo một hồ sơ gồm 4 tin vi phạm và gửi cho QTV. Bot **không tự kick** khi lập hồ sơ. Hồ sơ chờ duyệt thêm một khoảng thời gian bằng `violationWindowHours`; hết hạn thì không thể dùng để kick. Từ chối hồ sơ sẽ đặt lại bộ đếm của thành viên đó. Vì vậy, một tin link bị xóa vẫn chưa làm thành viên bị kick.

QTV của nhóm có thể gửi các lệnh sau trong nhóm gốc hoặc nhắn riêng cho tài khoản bot:

```text
/vipham                 Xem số lần vi phạm còn hiệu lực và hồ sơ chờ duyệt
/duyetkick MA_HO_SO      Duyệt và kick đúng một thành viên trong hồ sơ
/tuchoikick MA_HO_SO     Từ chối hồ sơ, đặt lại bộ đếm
```

Khi QTV gửi `/vipham` **trong nhóm gốc**, bot trả tối đa 10 thành viên có vi phạm còn hiệu lực tại nhóm đó, gồm cả người mới vi phạm 1–3 lần và người có hồ sơ chờ duyệt. Danh sách có tag `@TênThànhViên` thật để bấm xem người vi phạm. Với hồ sơ chờ duyệt, bot ghi riêng số tin trong hồ sơ và số lần hiện còn trong cửa sổ thời gian. Thông báo lập hồ sơ trong nhóm cũng tag người đó. Khi gửi `/vipham` qua tin riêng hoặc trong nhóm QTV riêng, bot gửi danh sách của các nhóm mà người ra lệnh đang là QTV qua tin riêng với `@TênThànhViên` dạng chữ; bot chỉ gắn mention thật ở nhóm gốc. UID vẫn được lưu nội bộ để duyệt kick chính xác nhưng không hiện làm tên chính của người vi phạm. Hồ sơ cũ sẽ lấy tên hiện tại từ danh sách thành viên nhóm nếu có. Nếu chưa có tin vi phạm còn hiệu lực, bot nói rõ danh sách đang trống; nếu không phải QTV, bot báo thiếu quyền.

Lệnh trực tiếp dưới đây chỉ dùng **trong nhóm gốc**:

```text
/kick @TênThànhViên      QTV tag đúng một người và kick ngay
```

Bot xác minh người ra lệnh là trưởng/phó nhóm hiện tại qua Zalo trước mỗi lần kick. Bot không chấp nhận `@all`, nhiều tag, QTV, tài khoản bot, hoặc người trong `trustedUserIds` làm mục tiêu. Lệnh `/kick @tag` là hành động trực tiếp của QTV nên không đi qua hồ sơ vi phạm. Nếu QTV bấm `/duyetkick`, bot kiểm tra lại hồ sơ, quyền QTV và mục tiêu trước khi gọi API kick.

`moderation-state.json` lưu các lần vi phạm, link, tên hiển thị, hồ sơ và lịch sử kick trên máy chạy bot; file này không nằm trong ZIP hay Git. Giữ file này riêng tư. Đừng xóa file khi bot đang chạy. Nếu tin riêng tới QTV bị chặn, có thể cấu hình nhóm QTV riêng qua `reviewGroupId` để nhận hồ sơ.

Nếu nâng cấp từ bản bot trước: dừng bot, giữ lại `config.json` và `moderation-state.json`, thay các file mã nguồn bằng bản mới, chạy `npm ci`, rồi kiểm tra với `dryRun: true`. `blockZaloLinks`, `historySweepSeconds`, `violationWindowHours` và `reviewGroupId` là tùy chọn; cấu hình cũ vẫn chạy. Bot không đọc hoặc điều khiển mã của một bot khác đang chạy trên máy.

Nếu lệnh xóa báo lỗi, kiểm tra quyền quản trị nhóm và tài khoản đăng nhập. Thư viện không chính thức có thể không tương thích khi Zalo cập nhật. Bot ghi ID nhóm, người gửi, tin và tên miền vào console để kiểm tra; file trạng thái lưu tối đa bốn link làm bằng chứng cho mỗi hồ sơ. Khi đăng nhập QR, bot lưu cookie vào `zalo-session.json` và bỏ qua file này khi dùng Git.

## Kiểm tra

```powershell
npm test
```
