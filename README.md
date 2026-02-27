# 📚 SangTacViet Userscripts

Bộ userscript nâng cao trải nghiệm đọc truyện và quản lý nội dung trên [SangTacViet](https://sangtacviet.app).

> **EN:** A collection of userscripts that enhance the reading and content-management experience on the SangTacViet novel platform.

---

## 📋 Danh sách Script

| Script | Phiên bản | Mô tả |
|--------|-----------|-------|
| [SangTacViet Nghe Sach Plus](#-sangtacviet-nghe-sach-plus) | v2.1 | Nghe sách tự động với nhiều tính năng nâng cao |
| [SangTacViet Tach File](#-sangtacviet-tach-file) | v29.0 | Tách file TXT dài thành từng chương và upload tự động |

---

## 🎧 SangTacViet Nghe Sach Plus

**File:** `SangTacViet Nghe Sach.js`  
**Tác giả:** @NMT25  
**Giấy phép:** MIT  
**Cài đặt từ Greasy Fork:** [SangTacViet Nghe Sach Plus](https://update.greasyfork.org/scripts/556860/SangTacViet%20Nghe%20Sach%20Plus.user.js)

### ✨ Tính năng

- 🔊 **Nút nghe sách riêng biệt** – nút gradient tím cố định ở góc màn hình, hoạt động song song với TTS gốc
- ⏱️ **Bộ đếm thời gian** – đếm riêng thời gian nghe theo chương và tổng thời gian theo sách
- ⏭️ **Tự động chuyển chương** – phát hiện khi chương kết thúc và chuyển sang chương tiếp theo
- 🚀 **Preload chương kế** – tải trước nội dung chương tiếp theo khi đọc được ~70% chương hiện tại
- 🔖 **Ghi nhớ vị trí đọc** – tự động lưu câu đang đọc, tiếp tục từ vị trí cũ khi mở lại
- ⭕ **Vòng tiến trình SVG** – hiển thị phần trăm câu đã đọc dưới dạng vòng tròn quanh nút
- 📱 **Responsive** – hỗ trợ cả desktop và mobile

### 🖱️ Cách sử dụng

| Hành động | Kết quả |
|-----------|---------|
| Click nút 🎧 | Bắt đầu nghe / Tiếp tục từ vị trí đã lưu |
| Click khi đang phát | Tạm dừng |
| Hover lên nút | Hiện tooltip: thời gian chương, tổng thời gian, % tiến độ |

### 🌐 Trang hỗ trợ

Hoạt động trên tất cả các domain của SangTacViet:
`sangtacviet.com` · `sangtacviet.app` · `sangtacviet.me` · `sangtacviet.pro` · `sangtacviet.vip`

---

## ✂️ SangTacViet Tach File

**File:** `SangTacViet Tach File.js`  
**Tác giả:** Bạn & AI Helper  
**Trang áp dụng:** `/uploader/list-chapter/*` và `/uploader/add-chapter/*`

### ✨ Tính năng

- 📂 **Tách file TXT dài** – tự động nhận diện tiêu đề chương bằng regex thông minh, hỗ trợ cả tiếng Trung và tiếng Việt
- 🌐 **Tự động dịch tiêu đề** – gọi API dịch tích hợp sẵn của trang để dịch tên chương trước khi upload
- 👁️ **Xem trước danh sách chương** – bảng preview với checkbox cho phép chọn/bỏ chương trước khi upload
- ✅ **Chọn theo range** – chọn nhanh từ chương X đến chương Y, hoặc đảo chiều lựa chọn
- ⏱️ **ETA (thời gian còn lại)** – thanh tiến độ hiển thị số chương hoàn thành, tốc độ và thời gian ước tính
- 🔄 **Worker Timer** – sử dụng Web Worker để bộ đếm giờ không bị trình duyệt throttle khi tab ẩn
- 🛡️ **Tự động thử lại** – mỗi chương được thử tối đa 3 lần nếu gặp lỗi mạng
- 🔤 **Tự động chọn encoding** – thử cả UTF-8 và GBK/GB18030, tự động chọn encoding cho ra nhiều chương hơn

### 🖱️ Cách sử dụng

1. Vào trang **Uploader** trên SangTacViet
2. Nhấn nút **📂 Chọn File TXT** và chọn một hoặc nhiều file
3. Script tự động cắt file thành các chương
4. Xem bảng preview, chọn/bỏ chọn chương cần upload
5. Nhấn **Bắt đầu Upload** và theo dõi tiến độ qua ETA panel

---

## 🛠️ Cài đặt

### Yêu cầu

Cần có một trình quản lý userscript như:
- [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Firefox, Edge, Safari)
- [Violentmonkey](https://violentmonkey.github.io/) (Chrome, Firefox)

### Các bước cài đặt thủ công

1. Cài Tampermonkey / Violentmonkey cho trình duyệt của bạn
2. Mở Dashboard của Tampermonkey → **Tạo script mới**
3. Xóa nội dung mặc định và dán toàn bộ nội dung file `.js` tương ứng vào
4. Nhấn **Lưu** (Ctrl+S)
5. Truy cập trang SangTacViet để script tự động kích hoạt

---

## 📜 Giấy phép

- `SangTacViet Nghe Sach.js` – [MIT License](https://opensource.org/licenses/MIT)
- `SangTacViet Tach File.js` – sử dụng cá nhân tự do
