import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [html, js] = await Promise.all([
  readFile(path.join(root, "public", "ui", "index.html"), "utf8"),
  readFile(path.join(root, "public", "ui", "app.js"), "utf8"),
]);
const ui = html + "\n" + js;

const vietnameseDiacritics = /[ÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚĂĐĨŨƠƯàáâãèéêìíòóôõùúăđĩũơưẠ-ỹ]/;
assert.doesNotMatch(ui, vietnameseDiacritics);
assert.match(html, /<html lang="en">/);

for (const phrase of [
  "Tổng quan", "Nhật ký", "Cài đặt", "Đang kết nối", "Làm mới",
  "Thêm server", "Import từ", "Tự động quét", "tùy chọn",
  "Tất cả", "Thực thi tool", "Mọi trạng thái", "Chỉ lỗi",
  "Tìm tool", "Xóa hiển thị", "Chưa có log", "Tên hiển thị",
  "Bật server", "phẩy", "Tools từ upstream", "Tải tools", "Hủy",
  "Sửa", "Xóa", "Không có", "Đã xóa", "không mới",
  "Nhập ID", "phải là", "Đã lưu", "Nhập đường dẫn",
]) {
  assert.ok(!ui.includes(phrase), `non-English UI phrase remains: ${phrase}`);
}

for (const phrase of [
  "Overview", "Activity", "Settings", "Connecting", "Refresh",
  "Add Server", "Import from IDE / CLI", "Display Name", "Enable Server",
  "Cancel", "Save",
]) {
  assert.ok(ui.includes(phrase), `expected English UI phrase missing: ${phrase}`);
}

console.log("OK  Admin UI user-facing wording is English-only");
