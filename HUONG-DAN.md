# 🇬🇧 EnglishDaily — App học tiếng Anh giao tiếp hằng ngày

## Cách mở app

**Cách 1 (đơn giản nhất):** Nháy đúp vào tệp `index.html` — app mở bằng trình duyệt (nên dùng **Google Chrome** hoặc **Microsoft Edge** để có đầy đủ tính năng đọc giọng nói và chấm điểm phát âm).

**Cách 2 (khuyến nghị, ổn định hơn):** Mở PowerShell trong thư mục này và chạy:

```
python -m http.server 8123
```

rồi mở trình duyệt vào địa chỉ: `http://localhost:8123`

## Tính năng

| Tính năng | Mô tả |
|---|---|
| 🎯 Kiểm tra đầu vào | 10 câu trắc nghiệm, tự động xếp trình độ (Cơ bản / Sơ trung / Trung cấp) |
| 🗺️ Lộ trình tự động | Tạo lộ trình học theo trình độ: Cơ bản = 30 ngày đầy đủ; trình độ cao hơn = lộ trình rút gọn, tăng tốc |
| 📚 21 chủ đề giao tiếp | Chào hỏi, gia đình, ăn uống, mua sắm, hỏi đường, khám bệnh, du lịch, khẩn cấp, small talk… |
| 📖 Mỗi bài học | Từ vựng (kèm phiên âm IPA + máy đọc), mẫu câu, hội thoại song ngữ, quiz 8 câu |
| 🃏 Flashcard SRS | Ôn tập ngắt quãng — từ đã học tự động lên lịch ôn (1 → 3 → 7 → 16 ngày) |
| 🎤 Luyện nói | Nghe mẫu (thường/chậm), đọc theo qua micro, hệ thống chấm điểm phát âm 0–100 |
| 🔥 Theo dõi tiến độ | Chuỗi ngày học (streak), số từ đã nhớ, độ chính xác quiz — lưu tự động trên máy |

## Cách học hiệu quả mỗi ngày (15–20 phút)

1. Mở app → **Tổng quan** → bấm **"Học ngay"** với bài của ngày hôm đó.
2. Học lần lượt: Từ vựng (bấm 🔊 nghe từng từ) → Mẫu câu → Hội thoại → làm Quiz (cần ≥60% để qua ngày).
3. Vào **Flashcard ôn tập** — ôn hết các thẻ đến hạn.
4. Vào **Luyện nói** — đọc to 3–5 câu, nghe lại mẫu nếu điểm thấp.

## 📲 Cài đặt lên điện thoại (PWA)

App là **Progressive Web App** — cài được lên màn hình chính, mở toàn màn hình như app thật, chạy được cả khi mất mạng (offline).

**Bước 1 — Đưa app lên mạng (chỉ làm một lần, miễn phí):**

Điện thoại cần truy cập app qua địa chỉ HTTPS. Hai cách dễ nhất:

- **Netlify Drop** (nhanh nhất, không cần tài khoản GitHub): vào `https://app.netlify.com/drop`, kéo-thả cả thư mục `Học Tiêng Anh` vào trang → nhận ngay một địa chỉ dạng `https://ten-gi-do.netlify.app`.
- **GitHub Pages**: tạo repository, tải toàn bộ tệp lên, bật Pages trong Settings.

**Bước 2 — Cài trên điện thoại:**

- **Android (Chrome):** mở địa chỉ app → hiện nút **"📲 Cài đặt app"** trong menu (hoặc Chrome tự gợi ý "Thêm vào màn hình chính") → bấm Cài đặt.
- **iPhone (Safari):** mở địa chỉ app → bấm nút **Chia sẻ** (ô vuông mũi tên) → **"Thêm vào MH chính"**.

Sau khi cài, icon EnglishDaily xuất hiện trên màn hình chính, mở như app bình thường.

## 🔔 Thông báo nhắc học

- Vào **Tổng quan → Cài đặt → Nhắc học hằng ngày**: chọn giờ (mặc định 20:00) và bấm **Bật** → cho phép thông báo khi trình duyệt hỏi.
- Nếu đến giờ đã chọn mà hôm đó bạn chưa học, app sẽ gửi thông báo nhắc (kèm số ngày streak để tạo động lực 🔥).
- *Giới hạn kỹ thuật:* thông báo hoạt động khi app/trình duyệt đang mở (kể cả chạy nền trên Android). Web app không thể tự gửi thông báo khi trình duyệt bị tắt hoàn toàn — đó là giới hạn chung của mọi PWA không có máy chủ đẩy (push server).

## Lưu ý

- Tiến độ lưu trong trình duyệt (localStorage) — dùng cùng một trình duyệt/app đã cài để giữ tiến độ.
- Tính năng chấm điểm phát âm (micro) cần **Google Chrome** và kết nối mạng; nếu không có micro, trong ngày "Thử thách luyện nói" có nút **"Bỏ qua chấm điểm"**.
- Muốn làm lại từ đầu: bấm **"🔄 Làm lại từ đầu"** (menu trái trên máy tính, hoặc trong phần Cài đặt ở Tổng quan trên điện thoại).
- Trên điện thoại, menu chuyển thành **thanh điều hướng dưới đáy màn hình** với 5 mục: Tổng quan · Lộ trình · Flashcard · Luyện nói · Chủ đề.
