const admin = require('firebase-admin');

function getAdmin() {
  if (admin.apps.length) return admin;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('ยังไม่ได้ตั้งค่า FIREBASE_SERVICE_ACCOUNT_JSON ใน Vercel');
  let serviceAccount;
  try { serviceAccount = JSON.parse(raw); } catch { throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON ไม่ใช่ JSON ที่ถูกต้อง'); }
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  return admin;
}

function json(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function cleanBase64(value) {
  if (typeof value !== 'string') return '';
  const m = value.match(/^data:[^;]+;base64,(.+)$/s);
  return m ? m[1] : value.replace(/^\s+|\s+$/g, '');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { success:false, message:'Method Not Allowed' });
  try {
    const apiKey = process.env.EASYSLIP_API_KEY;
    if (!apiKey) throw new Error('ยังไม่ได้ตั้งค่า EASYSLIP_API_KEY ใน Vercel');

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const token = String(body.token || '').toLowerCase().replace(/\s/g, '');
    const accessCode = String(body.accessCode || '').toLowerCase().replace(/\s/g, '');
    const base64 = cleanBase64(body.base64);
    if (!/^[a-f0-9]{48}$/.test(token) || !/^[a-f0-9]{40}$/.test(accessCode) || token.slice(8) !== accessCode) {
      return json(res, 400, { success:false, message:'ข้อมูลออร์เดอร์ไม่ถูกต้อง' });
    }
    if (!base64 || base64.length > 8 * 1024 * 1024) return json(res, 400, { success:false, message:'ไฟล์สลิปไม่ถูกต้องหรือมีขนาดใหญ่เกินไป' });

    const A = getAdmin();
    const db = A.firestore();
    const orderRef = db.collection('orders_cakee').doc(token);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) return json(res, 404, { success:false, message:'ไม่พบออร์เดอร์ค่ะ' });
    const order = orderSnap.data();
    if (order.orderNo !== 'AM-' + token.slice(0, 8).toUpperCase()) return json(res, 400, { success:false, message:'เลขออร์เดอร์ไม่ตรงกัน' });
    if (order.status === 'paid') return json(res, 409, { success:false, message:'ออร์เดอร์นี้ชำระเงินแล้วค่ะ' });
    if (order.status === 'cancelled') return json(res, 409, { success:false, message:'ออร์เดอร์นี้ถูกยกเลิกแล้วค่ะ' });
    if (!['awaiting_slip','submitted','rejected'].includes(order.status)) return json(res, 409, { success:false, message:'สถานะออร์เดอร์ไม่พร้อมตรวจสลิปค่ะ' });

    const expected = Number(order.totalCents) / 100;
    if (!Number.isFinite(expected) || expected <= 0) return json(res, 400, { success:false, message:'ยอดออร์เดอร์ไม่ถูกต้อง' });

    const options = {
      base64: body.base64,
      remark: String(order.orderNo).slice(0, 255),
      matchAmount: expected,
      checkDuplicate: true
    };
    if (String(process.env.EASYSLIP_MATCH_ACCOUNT || '').toLowerCase() === 'true') options.matchAccount = true;

    const easy = await fetch('https://api.easyslip.com/v2/verify/bank', {
      method:'POST',
      headers:{ Authorization:`Bearer ${apiKey}`, 'Content-Type':'application/json' },
      body:JSON.stringify(options)
    });
    const result = await easy.json().catch(() => ({}));
    if (!easy.ok || !result.success) {
      const code = result?.error?.code || 'VERIFY_FAILED';
      const msg = result?.error?.message || 'EasySlip ไม่สามารถตรวจสอบสลิปได้';
      return json(res, 422, { success:false, code, message:msg });
    }

    const data = result.data || {};
    const amount = Number(data.amountInSlip ?? data.rawSlip?.amount?.amount);
    const amountMatched = data.isAmountMatched !== undefined ? data.isAmountMatched : Math.abs(amount - expected) < 0.005;
    if (!amountMatched || Math.abs(amount - expected) >= 0.005) return json(res, 422, { success:false, message:`ยอดในสลิป ${amount.toFixed(2)} บาท ไม่ตรงกับยอดออร์เดอร์ ${expected.toFixed(2)} บาท` });
    if (data.isDuplicate) return json(res, 422, { success:false, message:'สลิปนี้เคยถูกตรวจสอบแล้วค่ะ ไม่สามารถใช้ซ้ำได้' });
    if (String(process.env.EASYSLIP_MATCH_ACCOUNT || '').toLowerCase() === 'true' && !data.matchedAccount) return json(res, 422, { success:false, message:'บัญชีผู้รับในสลิปไม่ตรงกับบัญชีร้านค่ะ' });

    await db.runTransaction(async tx => {
      const fresh = await tx.get(orderRef);
      if (!fresh.exists || fresh.data().status === 'paid' || fresh.data().status === 'cancelled') throw new Error('ออร์เดอร์นี้ถูกเปลี่ยนสถานะแล้ว กรุณาเปิดใหม่ค่ะ');
      const current = fresh.data();
      const items = current.items || [];
      if (!items.length || items.length > 20 || items.some(item => !Number.isInteger(item.qty) || item.qty < 1 || item.qty > 20 || !Number.isInteger(item.priceCents) || item.priceCents < 1) || items.reduce((sum,item)=>sum+item.qty*item.priceCents,0)!==current.totalCents) throw new Error('ข้อมูลสินค้าในออร์เดอร์ไม่ถูกต้อง');

      const productSnaps = [], stockSnaps = [];
      for (const item of items) {
        productSnaps.push(await tx.get(db.collection('products_cakee').doc(item.productId)));
        stockSnaps.push(item.deliveryType === 'custom' ? null : await tx.get(db.collection('product_delivery_cakee').doc(item.productId)));
      }
      items.forEach((item,i)=>{
        const product = productSnaps[i].data();
        if (!product || String(product.title||'สินค้า') !== item.title || Math.round(Number(product.priceBaht)*100) !== item.priceCents || product.deliveryType !== item.deliveryType) throw new Error('ราคาหรือประเภทสินค้ามีการแก้ไข กรุณาติดต่อร้านค่ะ');
        const stock = stockSnaps[i]?.data();
        if (item.deliveryType === 'file') {
          if (!stock?.fileData) throw new Error('สินค้านี้ยังไม่มีไฟล์สำหรับส่งค่ะ');
          tx.set(orderRef.collection('deliveries').doc(item.productId), { fileData:stock.fileData, fileName:stock.fileName||'สินค้า', deliveredAt:A.firestore.FieldValue.serverTimestamp() });
        }
        if (item.deliveryType === 'code') {
          if (!stock || !Array.isArray(stock.codes) || stock.codes.length < item.qty) throw new Error('โค้ดสินค้าไม่เพียงพอค่ะ');
          tx.set(orderRef.collection('deliveries').doc(item.productId), { codes:stock.codes.slice(0,item.qty), deliveredAt:A.firestore.FieldValue.serverTimestamp() });
          tx.update(stockSnaps[i].ref, { codes:stock.codes.slice(item.qty) });
          tx.update(productSnaps[i].ref, { stockCount:stock.codes.length-item.qty });
        }
      });

      tx.set(db.collection('order_slips_cakee').doc(token), {
        image: String(body.base64),
        verified:true,
        easySlip:{ transRef:data.rawSlip?.transRef || '', amountInSlip:amount, isDuplicate:Boolean(data.isDuplicate), isAmountMatched:Boolean(amountMatched) },
        checkedAt:A.firestore.FieldValue.serverTimestamp()
      }, {merge:true});
      tx.update(orderRef, {
        status:'paid',
        paidAt:A.firestore.FieldValue.serverTimestamp(),
        paymentVerifiedBy:'easyslip',
        paymentTransRef:data.rawSlip?.transRef || '',
        paymentAmount:amount
      });
    });

    return json(res, 200, { success:true, message:'ตรวจสลิปสำเร็จค่ะ', orderNo:order.orderNo, transRef:data.rawSlip?.transRef || '', amount });
  } catch (error) {
    console.error(error);
    return json(res, 500, { success:false, message:error.message || 'เกิดข้อผิดพลาดในการตรวจสลิปค่ะ' });
  }
};
