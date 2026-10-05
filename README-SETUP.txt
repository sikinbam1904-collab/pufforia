ชุดแก้ระบบ Order สำหรับ แบมแบม.html

ไฟล์ในชุด:
- index.html = หน้าเว็บที่แพตช์ระบบ Order ให้ไม่อ่าน/เขียน orders_cakee และ order_slips_cakee จาก browser โดยตรง
- api/order.js = API ฝั่ง server สำหรับสร้าง/ค้นหา/จัดการ Order และ QR รับสินค้า
- package.json = dependency firebase-admin

สำคัญ:
1) หากโปรเจกต์เดิมมี api/verify-slip.js อยู่แล้ว ให้เก็บไฟล์นั้นไว้ด้วย เพราะหน้าเว็บยังใช้ /api/verify-slip สำหรับตรวจสลิปอัตโนมัติ
2) ตั้ง Vercel Environment Variable:
   FIREBASE_SERVICE_ACCOUNT_JSON = Service Account JSON ของ Firebase (เก็บเฉพาะฝั่ง server)
   FIREBASE_PROJECT_ID = pufforia-977d1 (ใส่ได้เพื่อยืนยันโปรเจกต์; ถ้า Service Account มี project_id แล้วก็ใช้ค่านั้นได้)
3) ติดตั้ง dependency จาก package.json
4) หลัง deploy แล้วจึงใช้ Firestore Rules แบบปิด client access สำหรับ:
   orders_cakee
   order_slips_cakee
   product_delivery_cakee (สำหรับไฟล์เว็บชุดนี้ ให้คงสิทธิ์เฉพาะแอดมิน เพราะหน้า Admin เดิมยังจัดการสต็อกผ่าน collection นี้โดยตรง)
5) ห้ามใส่ Service Account JSON หรือ secret/API key ลงใน index.html
6) หน้าเว็บยังใช้ /api/verify-slip ตามระบบเดิมของไฟล์นี้ ดังนั้น EasySlip endpoint เดิมต้องอยู่ในโปรเจกต์ด้วย

การเปลี่ยนแปลงใน index.html:
- สร้างออร์เดอร์ผ่าน POST /api/order action=create
- ค้นหาออร์เดอร์ผ่าน POST /api/order action=lookup และ refresh ทุก 8 วินาที
- โหลดรายการออร์เดอร์แอดมินผ่าน action=admin-list
- ดูสลิปผ่าน action=admin-slip
- ยืนยัน/ปฏิเสธ/ยกเลิก/ลบ/ส่งงาน/ย้ายสำเร็จผ่าน admin API
- สแกน QR รับสินค้าผ่าน action=admin-receive
- ไม่อ่าน/เขียน orders_cakee หรือ order_slips_cakee จาก browser โดยตรง

ตรวจ syntax แล้วทั้ง index.html และ api/order.js ผ่าน Node --check
