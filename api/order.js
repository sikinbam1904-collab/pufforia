const crypto = require('crypto');
const admin = require('firebase-admin');

function getDb() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_JSON');
    const serviceAccount = JSON.parse(raw);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: serviceAccount.project_id || process.env.FIREBASE_PROJECT_ID
    });
  }
  return admin.firestore();
}

const ADMIN_UID = 'GqZRVXiadraaamU7mLaXamwOPBf2';
const db = () => getDb();
const FieldValue = admin.firestore.FieldValue;

function send(res, status, body) {
  res.status(status).json(body);
}

function clean(v, max = 1000) {
  return String(v ?? '').trim().slice(0, max);
}

function validToken(token) {
  return /^[a-f0-9]{48}$/.test(String(token || ''));
}

function validSlipImage(image) {
  const value = String(image || '');
  if (!/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(value)) return false;
  return value.length <= 700 * 1024;
}

async function requireAdmin(req) {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) throw new Error('UNAUTHORIZED');
  const decoded = await admin.auth().verifyIdToken(header.slice(7));
  if (decoded.uid !== ADMIN_UID) throw new Error('FORBIDDEN');
  return decoded;
}

async function requireUser(req) {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) throw new Error('UNAUTHORIZED');
  return admin.auth().verifyIdToken(header.slice(7));
}

function cleanPlan(plan) {
  const unit = ['days','weeks','months'].includes(String(plan?.unit || '')) ? String(plan.unit) : '';
  const duration = Number(plan?.duration);
  const installments = Number(plan?.installments);
  if (!unit || !Number.isInteger(duration) || duration < 1 || duration > 3650 || !Number.isInteger(installments) || installments < 2 || installments > 60) return null;
  return { unit, duration, installments };
}

function planKey(plan) {
  const p = cleanPlan(plan);
  return p ? `${p.unit}:${p.duration}:${p.installments}` : '';
}

function addPlanDate(date, unit, amount) {
  const d = new Date(date.getTime());
  if (unit === 'days') d.setDate(d.getDate() + amount);
  else if (unit === 'weeks') d.setDate(d.getDate() + amount * 7);
  else d.setMonth(d.getMonth() + amount);
  return d;
}

function buildInstallmentSchedule(totalCents, plan) {
  const p = cleanPlan(plan);
  if (!p || !Number.isInteger(totalCents) || totalCents < 1) throw new Error('แผนผ่อนไม่ถูกต้อง');
  const base = Math.floor(totalCents / p.installments);
  const remainder = totalCents - base * p.installments;
  const now = new Date();
  return Array.from({ length: p.installments }, (_, index) => {
    const step = (p.duration * (index + 1)) / p.installments;
    let dueAt;
    if (p.unit === 'months') {
      const whole = Math.floor(step);
      const extraDays = Math.round((step - whole) * 30);
      dueAt = addPlanDate(addPlanDate(now, 'months', whole), 'days', extraDays);
    } else {
      dueAt = addPlanDate(now, p.unit, p.unit === 'weeks' ? Math.round(step) : Math.round(step));
    }
    return { number: index + 1, amountCents: base + (index < remainder ? 1 : 0), dueAt: dueAt.toISOString() };
  });
}

async function getOrderWithDeliveries(token) {
  const ref = db().collection('orders_cakee').doc(token);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const deliveriesSnap = await ref.collection('deliveries').get();
  const deliveries = deliveriesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  return { id: snap.id, ...snap.data(), deliveries };
}

function makeOrderToken() {
  return crypto.randomBytes(24).toString('hex');
}

async function createOrder(body, authUser = null) {
  const paymentMode = body.paymentMode === 'installment' ? 'installment' : 'full';
  if (paymentMode === 'installment' && !authUser) throw new Error('กรุณาเข้าสู่ระบบก่อนเลือกผ่อนสินค้า');
  const itemsInput = Array.isArray(body.items) ? body.items : [];
  if (!itemsInput.length || itemsInput.length > 20) throw new Error('รายการสินค้าไม่ถูกต้อง');

  const normalized = itemsInput.map(item => ({
    productId: clean(item.productId, 200),
    qty: Number(item.qty)
  }));
  if (normalized.some(x => !x.productId || !Number.isInteger(x.qty) || x.qty < 1 || x.qty > 20)) {
    throw new Error('จำนวนสินค้าไม่ถูกต้อง');
  }
  if (new Set(normalized.map(x => x.productId)).size !== normalized.length) {
    throw new Error('พบสินค้าซ้ำในออร์เดอร์');
  }

  const token = makeOrderToken();
  const orderRef = db().collection('orders_cakee').doc(token);
  let result;

  await db().runTransaction(async tx => {
    let totalCents = 0;
    const items = [];
    let commonPlanKey = '';
    let commonPlan = null;

    for (const line of normalized) {
      const productRef = db().collection('products_cakee').doc(line.productId);
      const snap = await tx.get(productRef);
      if (!snap.exists) throw new Error('ไม่พบสินค้า');
      const product = snap.data() || {};
      const priceCents = Math.round(Number(product.priceBaht) * 100);
      if (!Number.isInteger(priceCents) || priceCents <= 0) throw new Error('ราคาสินค้าไม่ถูกต้อง');
      if (product.soldOut) throw new Error(`${product.title || 'สินค้า'} หมดชั่วคราวค่ะ`);
      if (paymentMode === 'installment') {
        if (product.installmentEnabled !== true) throw new Error(`${product.title || 'สินค้า'} ไม่เปิดให้ผ่อนค่ะ`);
        const requestedPlan = cleanPlan(body.installmentPlan);
        const allowed = Array.isArray(product.installmentPlans) ? product.installmentPlans : [];
        const match = allowed.find(x => planKey(x) === planKey(requestedPlan));
        if (!match) throw new Error(`${product.title || 'สินค้า'} ไม่รองรับแผนผ่อนที่เลือกค่ะ`);
        const key = planKey(match);
        if (commonPlanKey && commonPlanKey !== key) throw new Error('สินค้าที่เลือกผ่อนต้องใช้แผนผ่อนเดียวกันค่ะ');
        commonPlanKey = key;
        commonPlan = cleanPlan(match);
      }
      if (product.deliveryType === 'code') {
        const stock = Number(product.stockCount);
        if (!Number.isInteger(stock) || stock < line.qty) {
          throw new Error(`${product.title || 'สินค้า'} เหลือสินค้า ${Number.isInteger(stock) ? stock : 0} ชิ้นค่ะ`);
        }
      }
      totalCents += priceCents * line.qty;
      if (totalCents > 999999900) throw new Error('ยอดออร์เดอร์สูงเกินกำหนด');
      items.push({
        productId: line.productId,
        title: clean(product.title || 'สินค้า', 120),
        qty: line.qty,
        priceCents,
        deliveryType: product.deliveryType || 'custom'
      });
    }

    const installmentPlan = paymentMode === 'installment' ? commonPlan : null;
    const installmentSchedule = installmentPlan ? buildInstallmentSchedule(totalCents, installmentPlan) : [];
    const order = {
      orderNo: 'AM-' + token.slice(0, 8).toUpperCase(),
      name: clean(body.name, 120),
      contact: clean(body.contact, 120),
      email: clean(body.email, 200),
      note: clean(body.note, 1000),
      items,
      totalCents,
      paymentMode,
      customerUid: paymentMode === 'installment' ? authUser.uid : '',
      status: paymentMode === 'installment' ? 'installment_active' : 'awaiting_slip',
      ...(installmentPlan ? {
        installment: {
          plan: installmentPlan,
          schedule: installmentSchedule,
          currentInstallment: 1,
          paidInstallments: 0,
          paidCents: 0,
          remainingCents: totalCents
        }
      } : {}),
      createdAt: FieldValue.serverTimestamp()
    };
    tx.create(orderRef, order);
    result = { token, orderNo: order.orderNo, accessCode: token.slice(8).toUpperCase() };
  });

  return result;
}

async function verifyEasySlip(image, order, expectedCents = order.totalCents) {
  const apiKey = String(process.env.EASYSLIP_API_KEY || '').trim();
  if (!apiKey) throw new Error('EASYSLIP_NOT_CONFIGURED');

  const matchAccount = String(process.env.EASYSLIP_MATCH_ACCOUNT || '').toLowerCase() === 'true';
  const amountBaht = Number(expectedCents) / 100;
  const payload = {
    base64: image,
    remark: clean(order.orderNo || '', 255),
    matchAmount: amountBaht,
    checkDuplicate: true
  };
  if (matchAccount) payload.matchAccount = true;

  const response = await fetch('https://api.easyslip.com/v2/verify/bank', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.success) {
    const code = result?.error?.code || `HTTP_${response.status}`;
    const message = result?.error?.message || 'EasySlip ตรวจสลิปไม่สำเร็จ';
    const error = new Error(message);
    error.code = code;
    throw error;
  }

  const data = result.data || {};
  const amountInSlip = Number(data.amountInSlip ?? data.rawSlip?.amount?.amount);
  const amountMatched = data.isAmountMatched === true ||
    (Number.isFinite(amountInSlip) && amountInSlip === amountBaht);
  const accountMatched = !matchAccount || data.matchedAccount != null;

  if (data.isDuplicate === true) {
    const error = new Error('สลิปนี้เคยถูกตรวจสอบแล้วค่ะ');
    error.code = 'DUPLICATE_SLIP';
    throw error;
  }
  if (!amountMatched) {
    const error = new Error(`ยอดในสลิปไม่ตรงกับยอดที่ต้องชำระค่ะ (${Number.isFinite(amountInSlip) ? amountInSlip.toFixed(2) : '-'} บาท)`);
    error.code = 'AMOUNT_MISMATCH';
    throw error;
  }
  if (!accountMatched) {
    const error = new Error('บัญชีผู้รับในสลิปไม่ตรงกับบัญชีร้านที่ลงทะเบียนกับ EasySlip ค่ะ');
    error.code = 'ACCOUNT_MISMATCH';
    throw error;
  }

  return {
    data,
    message: result.message || 'Bank slip verified successfully'
  };
}

async function saveSubmittedSlip(token, image, verification = {}) {
  const orderRef = db().collection('orders_cakee').doc(token);
  const slipRef = db().collection('order_slips_cakee').doc(token);
  await db().runTransaction(async tx => {
    const snap = await tx.get(orderRef);
    if (!snap.exists) throw new Error('ไม่พบออร์เดอร์ค่ะ');
    const order = snap.data() || {};
    if (!['awaiting_slip', 'rejected'].includes(order.status)) throw new Error('ออร์เดอร์นี้ไม่สามารถส่งสลิปซ้ำได้');
    tx.set(slipRef, {
      image,
      imageHost: 'base64',
      submittedAt: FieldValue.serverTimestamp(),
      verificationStatus: verification.status || 'pending',
      verificationCode: clean(verification.code || '', 80),
      verificationMessage: clean(verification.message || '', 500),
      verifiedAt: verification.status === 'verified' ? FieldValue.serverTimestamp() : FieldValue.delete(),
      easySlipData: verification.data || FieldValue.delete()
    });
    tx.update(orderRef, { status: 'submitted' });
  });
}

async function submitSlip(body) {
  const token = clean(body.token, 100);
  if (!validToken(token)) throw new Error('รหัสออร์เดอร์ไม่ถูกต้อง');
  const image = String(body.image || '');
  if (!validSlipImage(image)) throw new Error('ไฟล์สลิปต้องเป็น JPG, PNG หรือ WebP และมีขนาดไม่เกิน 700 KB');

  const order = await getOrderWithDeliveries(token);
  if (!order) throw new Error('ไม่พบออร์เดอร์ค่ะ');
  if (!['awaiting_slip', 'rejected'].includes(order.status)) throw new Error('ออร์เดอร์นี้ไม่สามารถส่งสลิปซ้ำได้');

  try {
    const verification = await verifyEasySlip(image, order);
    await saveSubmittedSlip(token, image, {
      status: 'verified',
      code: '',
      message: verification.message,
      data: verification.data
    });

    try {
      await adminApprove(token);
      return { ok: true, verified: true, message: 'ตรวจสลิปสำเร็จและยืนยันการชำระเงินแล้วค่ะ' };
    } catch (approvalError) {
      console.error('EasySlip verified but automatic fulfillment failed', approvalError);
      return { ok: true, verified: true, manualReview: true, message: 'ตรวจสลิปผ่านแล้ว แต่ระบบส่งสินค้าอัตโนมัติไม่สำเร็จ กรุณาให้แอดมินตรวจออร์เดอร์ค่ะ' };
    }
  } catch (error) {
    console.error('EasySlip verification failed', error);
    const code = error.code || 'EASYSLIP_ERROR';
    const manualReviewCodes = new Set([
      'EASYSLIP_NOT_CONFIGURED',
      'INVALID_API_KEY',
      'IP_NOT_ALLOWED',
      'QUOTA_EXCEEDED',
      'BRANCH_INACTIVE',
      'SERVICE_BANNED',
      'SERVICE_DELETED',
      'API_SERVER_ERROR',
      'HTTP_401',
      'HTTP_403',
      'HTTP_429',
      'HTTP_500',
      'HTTP_502',
      'HTTP_503'
    ]);

    if (manualReviewCodes.has(code)) {
      await saveSubmittedSlip(token, image, {
        status: 'manual_review',
        code,
        message: error.message
      });
      return { ok: true, verified: false, manualReview: true, message: 'ส่งสลิปแล้วค่ะ ระบบตรวจอัตโนมัติขัดข้อง จึงส่งให้แอดมินตรวจสอบค่ะ' };
    }

    throw error;
  }
}


async function submitInstallmentSlip(body, user) {
  const token = clean(body.token, 100);
  if (!validToken(token)) throw new Error('รหัสออร์เดอร์ไม่ถูกต้อง');
  const image = String(body.image || '');
  if (!validSlipImage(image)) throw new Error('ไฟล์สลิปต้องเป็น JPG, PNG หรือ WebP และมีขนาดไม่เกิน 700 KB');
  const order = await getOrderWithDeliveries(token);
  if (!order || order.customerUid !== user.uid || order.paymentMode !== 'installment') throw new Error('ไม่พบรายการผ่อนของบัญชีนี้ค่ะ');
  if (order.status === 'paid') throw new Error('รายการนี้ชำระครบแล้วค่ะ');
  const installment = order.installment || {};
  const schedule = Array.isArray(installment.schedule) ? installment.schedule : [];
  const currentNo = Number(installment.currentInstallment || 1);
  const current = schedule.find(x => Number(x.number) === currentNo);
  if (!current) throw new Error('ไม่พบงวดที่ต้องชำระค่ะ');
  const verification = await verifyEasySlip(image, order, Number(current.amountCents));
  const paymentId = crypto.randomBytes(12).toString('hex');
  const paymentRef = db().collection('installment_payments_cakee').doc(paymentId);
  const orderRef = db().collection('orders_cakee').doc(token);
  let finalPayment = false;
  await db().runTransaction(async tx => {
    const snap = await tx.get(orderRef);
    if (!snap.exists) throw new Error('ไม่พบออร์เดอร์ค่ะ');
    const fresh = snap.data() || {};
    if (fresh.customerUid !== user.uid || fresh.paymentMode !== 'installment') throw new Error('ไม่พบรายการผ่อนของบัญชีนี้ค่ะ');
    const inst = fresh.installment || {};
    if (Number(inst.currentInstallment || 1) !== currentNo) throw new Error('งวดผ่อนมีการเปลี่ยนแปลง กรุณารีเฟรชหน้าแล้วลองใหม่ค่ะ');
    const paidCents = Number(inst.paidCents || 0) + Number(current.amountCents);
    const remainingCents = Math.max(0, Number(fresh.totalCents || 0) - paidCents);
    finalPayment = remainingCents === 0 || currentNo >= schedule.length;
    tx.create(paymentRef, {
      orderToken: token, customerUid: user.uid, installmentNo: currentNo, amountCents: Number(current.amountCents),
      image, imageHost: 'base64', verificationStatus: 'verified', easySlipData: verification.data || null, createdAt: FieldValue.serverTimestamp()
    });
    tx.update(orderRef, {
      status: finalPayment ? 'submitted' : 'installment_active',
      installment: { ...inst, paidInstallments: currentNo, currentInstallment: finalPayment ? currentNo : currentNo + 1, paidCents, remainingCents },
      lastInstallmentPaymentAt: FieldValue.serverTimestamp()
    });
    if (finalPayment) tx.set(db().collection('order_slips_cakee').doc(token), { image, imageHost:'base64', submittedAt:FieldValue.serverTimestamp(), verificationStatus:'verified', verificationCode:'', verificationMessage:verification.message, easySlipData:verification.data || null });
  });
  if (finalPayment) {
    try {
      await adminApprove(token);
      return { ok:true, verified:true, final:true, message:'งวดสุดท้ายผ่านแล้วค่ะ ชำระครบและยืนยันออร์เดอร์เรียบร้อยแล้ว' };
    } catch (e) {
      console.error('Final installment verified but fulfillment failed', e);
      return { ok:true, verified:true, final:true, manualReview:true, message:'งวดสุดท้ายผ่านแล้วค่ะ แต่ระบบส่งมอบอัตโนมัติไม่สำเร็จ กรุณาให้แอดมินตรวจออร์เดอร์ค่ะ' };
    }
  }
  return { ok:true, verified:true, final:false, message:`ชำระงวดที่ ${currentNo} สำเร็จค่ะ เหลือ ${schedule.length-currentNo} งวด` };
}

async function saveCustomerProfile(body, user) {
  const name = clean(body.name, 120);
  const phone = clean(body.phone, 40);
  const email = clean(body.email || user.email || '', 200);
  if (!name || !phone) throw new Error('กรุณากรอกชื่อและเบอร์โทรศัพท์ให้ครบค่ะ');
  await db().collection('customers_cakee').doc(user.uid).set({ name, phone, email, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { ok: true };
}

async function customerInstallments(user) {
  const snap = await db().collection('orders_cakee').where('customerUid', '==', user.uid).limit(100).get();
  return snap.docs.map(d => ({ id:d.id, ...d.data() })).filter(x => x.paymentMode === 'installment').sort((a,b) => {
    const aa = a.createdAt?.seconds || 0, bb = b.createdAt?.seconds || 0;
    return bb - aa;
  });
}


function normalizeLegacyInstallmentDoc(id, data) {
  const totalCents = Math.max(0, Math.round(Number(data?.totalCents ?? Number(data?.total||0)*100) || 0));
  const paidCents = Math.min(totalCents, Math.max(0, Math.round(Number(data?.paidCents ?? Number(data?.paid||0)*100) || 0)));
  const remainingCents = Math.max(0, totalCents-paidCents);
  const count = Math.max(1, Math.round(Number(data?.installmentCount ?? data?.totalInstallments) || 1));
  return {id,...data,totalCents,paidCents,remainingCents,total:totalCents/100,paid:paidCents/100,remaining:remainingCents/100,installmentCount:count,totalInstallments:count,installmentNo:Number(data?.installmentNo||data?.currentInstallment||1),currentInstallment:Number(data?.currentInstallment||data?.installmentNo||1),progress:totalCents?Math.round(paidCents/totalCents*10000)/100:0,statusLabel:data?.statusLabel||({'active':'กำลังผ่อน','completed':'ชำระครบแล้ว','cancelled':'ยกเลิก'}[data?.status]||data?.status||'กำลังผ่อน')};
}
async function getLegacyInstallmentById(id) {
  const ref=db().collection('installments_cakee').doc(clean(id,200));
  const snap=await ref.get(); if(!snap.exists)return null;
  return normalizeLegacyInstallmentDoc(snap.id,snap.data()||{});
}

async function legacyAdminInstallmentList() {
  const snap = await db()
    .collection('installments_cakee')
    .orderBy('createdAt', 'desc')
    .limit(300)
    .get();

  return snap.docs.map(d => normalizeLegacyInstallmentDoc(d.id, d.data() || {}));
}

async function legacyAdminInstallmentUpdate(body) {
  const id = clean(body.installmentId || body.id, 200);
  if (!id) throw new Error('ไม่พบรายการผ่อนค่ะ');
  const ref = db().collection('installments_cakee').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('ไม่พบรายการผ่อนค่ะ');
  const current = snap.data() || {};
  const patch = {};

  if (body.name !== undefined) patch.name = clean(body.name, 120);
  if (body.phone4 !== undefined) patch.phone4 = String(body.phone4 || '').replace(/\D/g,'').slice(-4);
  if (body.orderNo !== undefined) patch.orderNo = clean(body.orderNo, 120);
  if (body.product !== undefined) patch.product = clean(body.product, 300);
  if (body.total !== undefined) patch.total = Math.max(0, Number(body.total) || 0);
  if (body.paid !== undefined) patch.paid = Math.max(0, Number(body.paid) || 0);
  if (body.installmentNo !== undefined) patch.installmentNo = Math.max(1, Math.round(Number(body.installmentNo) || 1));
  if (body.totalInstallments !== undefined) patch.totalInstallments = Math.max(1, Math.round(Number(body.totalInstallments) || 1));
  if (body.nextDueDate !== undefined) patch.nextDueDate = clean(body.nextDueDate, 30);
  if (body.note !== undefined) patch.note = clean(body.note, 1000);

  if (body.status !== undefined) {
    const raw = String(body.status);
    const map = { 'กำลังผ่อน':'active', 'ชำระครบแล้ว':'completed', 'ค้างชำระ':'active', 'ยกเลิก':'cancelled' };
    patch.status = map[raw] || (['active','completed','cancelled'].includes(raw) ? raw : 'active');
    patch.statusLabel = raw;
  }

  const totalBaht = body.total !== undefined ? patch.total : Number(current.total || 0);
  const paidBaht = body.paid !== undefined ? patch.paid : Number(current.paid || 0);
  if (body.total !== undefined || body.paid !== undefined) {
    const safePaid = Math.min(Math.max(0, paidBaht), Math.max(0, totalBaht));
    patch.paid = safePaid;
    patch.remaining = Math.max(0, totalBaht - safePaid);
    patch.progress = totalBaht > 0 ? Math.round((safePaid / totalBaht) * 10000) / 100 : 0;
    patch.totalCents = Math.round(totalBaht * 100);
    patch.paidCents = Math.round(safePaid * 100);
    patch.remainingCents = Math.round(patch.remaining * 100);
    if (patch.remaining <= 0) { patch.status = 'completed'; patch.statusLabel = 'ชำระครบแล้ว'; }
  }

  if (body.totalInstallments !== undefined) patch.installmentCount = Math.max(1, Math.round(Number(body.totalInstallments) || 1));
  if (body.installmentNo !== undefined) patch.currentInstallment = Math.max(1, Math.round(Number(body.installmentNo) || 1));
  patch.updatedAt = FieldValue.serverTimestamp();
  if (!Object.keys(patch).length) throw new Error('ไม่มีข้อมูลสำหรับแก้ไข');
  await ref.update(patch);
  return { ok: true, installment: await getLegacyInstallmentById(id) };
}

async function legacyAdminInstallmentDelete(id) {
  const value = clean(id, 200);
  if (!value) throw new Error('ไม่พบรายการผ่อนค่ะ');

  const ref = db().collection('installments_cakee').doc(value);
  const slips = await ref.collection('slips').get();
  const batch = db().batch();

  slips.docs.forEach(doc => batch.delete(doc.ref));
  batch.delete(ref);
  await batch.commit();

  return { ok: true };
}





/* =========================================================
   ADMIN INSTALLMENT MANAGEMENT
   Supports both legacy installments_cakee records and the
   real customer installment orders stored in orders_cakee.
   ========================================================= */
function normalizeModernInstallmentAdmin(id, order) {
  const inst = order.installment || {};
  const schedule = Array.isArray(inst.schedule) ? inst.schedule : [];
  const currentNo = Math.max(1, Number(inst.currentInstallment) || 1);
  const totalCents = Math.max(0, Number(order.totalCents) || 0);
  const paidCents = Math.min(totalCents, Math.max(0, Number(inst.paidCents) || 0));
  const remainingCents = Math.max(0, totalCents - paidCents);
  const current = schedule.find(x => Number(x.number) === currentNo) || null;
  let status = order.status === 'paid' ? 'completed' : (order.status === 'cancelled' ? 'cancelled' : 'active');
  let statusLabel = status === 'completed' ? 'ชำระครบแล้ว' : status === 'cancelled' ? 'ยกเลิก' : 'กำลังผ่อน';
  return {
    id,
    uid: order.customerUid || '',
    name: order.name || '',
    phone4: String(order.contact || '').replace(/\D/g, '').slice(-4),
    orderNo: order.orderNo || ('AM-' + String(id).slice(0,8).toUpperCase()),
    product: Array.isArray(order.items) ? order.items.map(x => `${x.title || 'สินค้า'} × ${x.qty || 1}`).join(', ') : '',
    total: totalCents / 100,
    paid: paidCents / 100,
    remaining: remainingCents / 100,
    totalCents,
    paidCents,
    remainingCents,
    installmentNo: currentNo,
    currentInstallment: currentNo,
    totalInstallments: schedule.length || Number(inst.plan?.installments) || 1,
    installmentCount: schedule.length || Number(inst.plan?.installments) || 1,
    nextDueDate: current?.dueAt ? String(current.dueAt).slice(0,10) : '',
    status,
    statusLabel,
    note: order.note || '',
    progress: totalCents > 0 ? Math.round(paidCents / totalCents * 10000) / 100 : 0,
    paymentMode: 'installment',
    createdAt: order.createdAt || null,
    source: 'order',
    orderToken: id
  };
}

async function adminInstallmentList() {
  const legacy = await legacyAdminInstallmentList();
  const snap = await db().collection('orders_cakee').where('paymentMode', '==', 'installment').limit(300).get();
  const modern = snap.docs.map(d => normalizeModernInstallmentAdmin(d.id, { id:d.id, ...d.data() }));
  return [...legacy.map(x => ({...x, source:'legacy'})), ...modern]
    .sort((a,b) => {
      const aa = a.createdAt?.seconds ? a.createdAt.seconds * 1000 : Number(a.createdAt || 0);
      const bb = b.createdAt?.seconds ? b.createdAt.seconds * 1000 : Number(b.createdAt || 0);
      return bb - aa;
    });
}

async function adminInstallmentUpdate(body) {
  const id = clean(body.installmentId || body.id, 200);
  if (!id) throw new Error('ไม่พบรายการผ่อนค่ะ');
  const orderRef = db().collection('orders_cakee').doc(id);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists || orderSnap.data()?.paymentMode !== 'installment') {
    return legacyAdminInstallmentUpdate(body);
  }
  const current = orderSnap.data() || {};
  const inst = current.installment || {};
  const patch = {};
  if (body.name !== undefined) patch.name = clean(body.name, 120);
  if (body.contact !== undefined) patch.contact = clean(body.contact, 160);
  if (body.note !== undefined) patch.note = clean(body.note, 1000);
  const nextInst = { ...inst };
  if (body.total !== undefined) {
    const totalCents = Math.max(0, Math.round(Number(body.total) * 100));
    if (!totalCents) throw new Error('ยอดทั้งหมดต้องมากกว่า 0 ค่ะ');
    patch.totalCents = totalCents;
    nextInst.remainingCents = Math.max(0, totalCents - Math.min(totalCents, Number(nextInst.paidCents) || 0));
  }
  if (body.paid !== undefined) {
    const totalCents = Number(patch.totalCents || current.totalCents || 0);
    const paidCents = Math.min(totalCents, Math.max(0, Math.round(Number(body.paid) * 100)));
    nextInst.paidCents = paidCents;
    nextInst.remainingCents = Math.max(0, totalCents - paidCents);
  }
  if (body.installmentNo !== undefined) nextInst.currentInstallment = Math.max(1, Math.round(Number(body.installmentNo) || 1));
  if (body.totalInstallments !== undefined) {
    const count = Math.max(2, Math.min(60, Math.round(Number(body.totalInstallments) || 2)));
    if (nextInst.plan) nextInst.plan = { ...nextInst.plan, installments: count };
  }
  if (body.status !== undefined) {
    const raw = String(body.status);
    if (raw === 'ชำระครบแล้ว' || raw === 'completed') patch.status = 'paid';
    else if (raw === 'ยกเลิก' || raw === 'cancelled') patch.status = 'cancelled';
    else patch.status = 'installment_active';
  }
  if (body.nextDueDate && Array.isArray(nextInst.schedule) && nextInst.schedule.length) {
    const no = Number(nextInst.currentInstallment || 1);
    nextInst.schedule = nextInst.schedule.map(row => Number(row.number) === no ? { ...row, dueAt: new Date(body.nextDueDate + 'T23:59:59+07:00').toISOString() } : row);
  }
  const total = Number(patch.totalCents || current.totalCents || 0);
  const paid = Math.min(total, Math.max(0, Number(nextInst.paidCents || 0)));
  nextInst.paidCents = paid;
  nextInst.remainingCents = Math.max(0, total - paid);
  nextInst.paidInstallments = paid >= total && total > 0 ? (nextInst.schedule?.length || nextInst.plan?.installments || 1) : Math.max(0, Number(nextInst.currentInstallment || 1) - 1);
  if (nextInst.remainingCents === 0 && total > 0) { patch.status = 'paid'; nextInst.currentInstallment = nextInst.schedule?.length || nextInst.plan?.installments || nextInst.currentInstallment; }
  else if (!patch.status || patch.status === 'paid') patch.status = 'installment_active';
  patch.installment = nextInst;
  patch.updatedAt = FieldValue.serverTimestamp();
  await orderRef.update(patch);
  const updated = await orderRef.get();
  return { ok:true, installment: normalizeModernInstallmentAdmin(id, {id, ...updated.data()}) };
}

async function adminInstallmentDelete(id) {
  const value = clean(id, 200);
  if (!value) throw new Error('ไม่พบรายการผ่อนค่ะ');
  const orderRef = db().collection('orders_cakee').doc(value);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists || orderSnap.data()?.paymentMode !== 'installment') {
    return legacyAdminInstallmentDelete(value);
  }
  const deliveries = await orderRef.collection('deliveries').get();
  const payments = await db().collection('installment_payments_cakee').where('orderToken','==',value).get();
  const batch = db().batch();
  deliveries.docs.forEach(d => batch.delete(d.ref));
  payments.docs.forEach(d => batch.delete(d.ref));
  batch.delete(db().collection('order_slips_cakee').doc(value));
  batch.delete(orderRef);
  await batch.commit();
  return { ok:true };
}

async function adminShippingList() {
  const snap = await db().collection('shipping_cakee').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a,b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}

async function adminShippingUpdate(body) {
  const id = clean(body.id || body.shippingId, 200);
  if (!id) throw new Error('ไม่พบรายการพัสดุค่ะ');
  const oldId = clean(body.oldId, 200);
  const payload = {
    name: clean(body.name, 120),
    phone4: String(body.phone4 || '').replace(/\D/g, '').slice(-4),
    carrier: clean(body.carrier, 120),
    trackingNo: clean(body.trackingNo, 200),
    detail: clean(body.detail, 2000),
    orderDate: clean(body.orderDate, 30),
    dueDate: clean(body.dueDate, 30),
    status: clean(body.status, 80),
    progress: Math.max(0, Math.min(100, Number(body.progress) || 0)),
    history: Array.isArray(body.history) ? body.history : [],
    updatedAt: Date.now(),
    createdAt: Number(body.createdAt) || Date.now()
  };
  if (!payload.name || payload.phone4.length !== 4 || !payload.trackingNo) {
    throw new Error('กรุณากรอกชื่อ เบอร์ 4 ตัวท้าย และเลขพัสดุให้ครบค่ะ');
  }
  await db().collection('shipping_cakee').doc(id).set(payload, { merge: false });
  if (oldId && oldId !== id) await db().collection('shipping_cakee').doc(oldId).delete();
  return { ok: true, shipping: { id, ...payload } };
}

async function adminShippingDelete(id) {
  const value = clean(id, 200);
  if (!value) throw new Error('ไม่พบรายการพัสดุค่ะ');
  await db().collection('shipping_cakee').doc(value).delete();
  return { ok: true };
}

async function adminList() {
  const snap = await db().collection('orders_cakee').orderBy('createdAt', 'desc').limit(300).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function adminSlip(id) {
  if (!validToken(id)) throw new Error('รหัสออร์เดอร์ไม่ถูกต้อง');
  const snap = await db().collection('order_slips_cakee').doc(id).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() };
}

async function adminApprove(id) {
  if (!validToken(id)) throw new Error('รหัสออร์เดอร์ไม่ถูกต้อง');
  const orderRef = db().collection('orders_cakee').doc(id);
  const slipRef = db().collection('order_slips_cakee').doc(id);

  await db().runTransaction(async tx => {
    const orderSnap = await tx.get(orderRef);
    const slipSnap = await tx.get(slipRef);
    if (!orderSnap.exists || orderSnap.data().status !== 'submitted' || !slipSnap.exists) {
      throw new Error('ออร์เดอร์หรือสลิปไม่พร้อม');
    }
    const order = orderSnap.data();
    const items = Array.isArray(order.items) ? order.items : [];
    if (!items.length || items.length > 20 || items.some(item => !Number.isInteger(item.qty) || item.qty < 1 || item.qty > 20 || !Number.isInteger(item.priceCents) || item.priceCents < 1)) {
      throw new Error('ข้อมูลสินค้าในออร์เดอร์ไม่ถูกต้อง');
    }
    if (new Set(items.map(item => item.productId)).size !== items.length || items.reduce((sum, item) => sum + item.qty * item.priceCents, 0) !== order.totalCents) {
      throw new Error('ยอดสินค้าไม่ตรง กรุณาตรวจออร์เดอร์');
    }

    const productSnaps = [];
    const stockSnaps = [];
    for (const item of items) {
      productSnaps.push(await tx.get(db().collection('products_cakee').doc(item.productId)));
      stockSnaps.push(item.deliveryType === 'custom' ? null : await tx.get(db().collection('product_delivery_cakee').doc(item.productId)));
    }

    items.forEach((item, index) => {
      const product = productSnaps[index].data();
      if (!product || clean(product.title || 'สินค้า', 120) !== item.title || Math.round(Number(product.priceBaht) * 100) !== item.priceCents || (product.deliveryType || 'custom') !== item.deliveryType) {
        throw new Error('ราคาหรือประเภทสินค้ามีการแก้ไข กรุณาตรวจสอบก่อนยืนยัน');
      }
      const stock = stockSnaps[index]?.data();
      if (item.deliveryType === 'file') {
        if (!stock?.fileData) throw new Error('ยังไม่มีไฟล์สำหรับ ' + item.title);
        tx.set(orderRef.collection('deliveries').doc(item.productId), {
          fileData: stock.fileData,
          fileName: stock.fileName || 'สินค้า',
          deliveredAt: FieldValue.serverTimestamp()
        });
      }
      if (item.deliveryType === 'code') {
        if (!stock || !Array.isArray(stock.codes) || stock.codes.length < item.qty) throw new Error('โค้ดของ ' + item.title + ' ไม่พอ');
        tx.set(orderRef.collection('deliveries').doc(item.productId), {
          codes: stock.codes.slice(0, item.qty),
          deliveredAt: FieldValue.serverTimestamp()
        });
        tx.update(stockSnaps[index].ref, { codes: stock.codes.slice(item.qty) });
        tx.update(productSnaps[index].ref, { stockCount: stock.codes.length - item.qty });
      }
    });
    tx.update(orderRef, { status: 'paid', paidAt: FieldValue.serverTimestamp() });
  });
  return { ok: true };
}

async function adminCustomDelivery(body) {
  const id = clean(body.id, 100);
  const productId = clean(body.productId, 200);
  if (!validToken(id) || !productId) throw new Error('ข้อมูลการส่งงานไม่ถูกต้อง');

  const orderRef = db().collection('orders_cakee').doc(id);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) throw new Error('ไม่พบออร์เดอร์ค่ะ');

  const order = orderSnap.data() || {};
  if (order.status !== 'paid') throw new Error('ต้องยืนยันชำระเงินก่อนจึงจะส่งงานได้ค่ะ');

  const item = Array.isArray(order.items)
    ? order.items.find(x => String(x.productId) === productId)
    : null;
  if (!item) throw new Error('สินค้านี้ไม่ได้อยู่ในออร์เดอร์ค่ะ');
  if (item.deliveryType !== 'custom') throw new Error('สินค้านี้ไม่ใช่สินค้าที่ส่งงานแบบกำหนดเองค่ะ');

  const text = clean(body.text, 5000);
  const fileData = String(body.fileData || '');
  const cloudinaryPublicId = clean(body.cloudinaryPublicId, 500);
  const imageHost = clean(body.imageHost, 500);
  const fileName = clean(body.fileName, 255);

  if (!text && !fileData) throw new Error('กรุณาใส่ข้อความหรือเลือกไฟล์ค่ะ');
  if (fileData.length > 450 * 1024) throw new Error('ไฟล์ส่งงานใหญ่เกิน 450 KB ค่ะ');
  if (imageHost && !['cloudinary', 'inline'].includes(imageHost)) {
    throw new Error('แหล่งไฟล์ส่งงานไม่ถูกต้องค่ะ');
  }

  await orderRef.collection('deliveries').doc(productId).set({
    text,
    fileData,
    cloudinaryPublicId,
    imageHost,
    fileName,
    deliveredAt: FieldValue.serverTimestamp()
  });
  return { ok: true };
}

async function adminReject(id) {
  if (!validToken(id)) throw new Error('รหัสออร์เดอร์ไม่ถูกต้อง');
  const ref = db().collection('orders_cakee').doc(id);
  await db().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('ไม่พบออร์เดอร์ค่ะ');
    if (snap.data().status !== 'submitted') {
      throw new Error('ออร์เดอร์นี้ไม่อยู่ในสถานะรอตรวจสลิปค่ะ');
    }
    tx.update(ref, { status: 'rejected', rejectedAt: FieldValue.serverTimestamp() });
  });
  return { ok: true };
}

async function adminCancel(id) {
  if (!validToken(id)) throw new Error('รหัสออร์เดอร์ไม่ถูกต้อง');
  const ref = db().collection('orders_cakee').doc(id);
  await db().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data().status === 'cancelled') throw new Error('ออร์เดอร์นี้ถูกลบหรือยกเลิกแล้ว');
    tx.update(ref, { status: 'cancelled', cancelledAt: FieldValue.serverTimestamp() });
  });
  return { ok: true };
}

async function adminDelete(id) {
  if (!validToken(id)) throw new Error('รหัสออร์เดอร์ไม่ถูกต้อง');
  const ref = db().collection('orders_cakee').doc(id);
  const deliveries = await ref.collection('deliveries').get();
  const batch = db().batch();
  deliveries.docs.forEach(d => batch.delete(d.ref));
  batch.delete(db().collection('order_slips_cakee').doc(id));
  batch.delete(ref);
  await batch.commit();
  return { ok: true };
}

async function adminReceive(id) {
  if (!validToken(id)) throw new Error('รหัสออร์เดอร์ไม่ถูกต้อง');
  const ref = db().collection('orders_cakee').doc(id);
  await db().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('ไม่พบออร์เดอร์ค่ะ');
    const order = snap.data() || {};
    if (order.orderNo !== 'AM-' + id.slice(0, 8).toUpperCase()) throw new Error('เลขออร์เดอร์ไม่ตรงกันค่ะ');
    if (order.status !== 'paid') throw new Error('ออร์เดอร์นี้ยังไม่ได้รับการยืนยันชำระเงินค่ะ');
    if (order.receivedAt) throw new Error('ออร์เดอร์นี้รับสินค้าไปแล้วค่ะ');
    tx.update(ref, { receivedAt: FieldValue.serverTimestamp(), receivedBy: ADMIN_UID });
  });
  return { ok: true };
}

async function adminComplete(id, completed) {
  if (!validToken(id)) throw new Error('รหัสออร์เดอร์ไม่ถูกต้อง');
  const ref = db().collection('orders_cakee').doc(id);
  await db().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('ไม่พบออร์เดอร์ค่ะ');
    const order = snap.data() || {};
    if (order.status !== 'paid') throw new Error('ต้องยืนยันชำระเงินก่อนจึงจะปิดงานได้ค่ะ');
    if (completed) {
      const items = Array.isArray(order.items) ? order.items : [];
      const needsReceive = items.some(item => item.deliveryType !== 'custom');
      if (needsReceive && !order.receivedAt) {
        throw new Error('ออร์เดอร์นี้ยังไม่ได้รับสินค้าโดยลูกค้าค่ะ');
      }
      const customItems = items.filter(item => item.deliveryType === 'custom');
      if (customItems.length) {
        const missing = [];
        for (const item of customItems) {
          const deliverySnap = await tx.get(ref.collection('deliveries').doc(item.productId));
          const delivery = deliverySnap.data() || {};
          if (!deliverySnap.exists || (!delivery.text && !delivery.fileData)) missing.push(item.title || item.productId);
        }
        if (missing.length) throw new Error('ยังส่งงานไม่ครบ: ' + missing.join(', '));
      }
    }
    tx.update(ref, {
      completedAt: completed ? FieldValue.serverTimestamp() : FieldValue.delete()
    });
  });
  return { ok: true };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  try {
    const body = req.body || {};
    const action = clean(body.action, 50);

    if (action === 'create') {
      let user = null;
      if (body.paymentMode === 'installment') user = await requireUser(req);
      return send(res, 200, { ok: true, ...(await createOrder(body, user)) });
    }
    if (action === 'lookup') {
      const token = clean(body.token, 100);
      if (!validToken(token)) return send(res, 400, { ok: false, error: 'รหัสออร์เดอร์ไม่ถูกต้อง' });
      const order = await getOrderWithDeliveries(token);
      if (!order || order.orderNo !== 'AM-' + token.slice(0, 8).toUpperCase()) return send(res, 404, { ok: false, error: 'ไม่พบออร์เดอร์ค่ะ' });
      return send(res, 200, { ok: true, order });
    }
    if (action === 'submit-slip') return send(res, 200, await submitSlip(body));
    if (action === 'installment-submit-slip') {
      const user = await requireUser(req);
      return send(res, 200, await submitInstallmentSlip(body, user));
    }
    if (action === 'installment-list') {
      const user = await requireUser(req);
      return send(res, 200, { ok:true, installments:await customerInstallments(user) });
    }
    if (action === 'customer-profile') {
      const user = await requireUser(req);
      return send(res, 200, await saveCustomerProfile(body, user));
    }

    if (action === 'admin-installment-list') return send(res, 200, { ok: true, installments: await adminInstallmentList() });
    if (action === 'admin-installment-update') return send(res, 200, await adminInstallmentUpdate(body));
    if (action === 'admin-installment-delete') return send(res, 200, await adminInstallmentDelete(clean(body.installmentId || body.id, 200)));
    if (action === 'admin-shipping-list') return send(res, 200, { ok: true, shipping: await adminShippingList() });
    if (action === 'admin-shipping-update') return send(res, 200, await adminShippingUpdate(body));
    if (action === 'admin-shipping-delete') return send(res, 200, await adminShippingDelete(clean(body.shippingId || body.id, 200)));

    await requireAdmin(req);
    if (action === 'admin-list') return send(res, 200, { ok: true, orders: await adminList() });
    if (action === 'admin-slip') return send(res, 200, { ok: true, slip: await adminSlip(clean(body.id, 100)) });
    if (action === 'admin-approve') return send(res, 200, await adminApprove(clean(body.id, 100)));
    if (action === 'admin-reject') return send(res, 200, await adminReject(clean(body.id, 100)));
    if (action === 'admin-cancel') return send(res, 200, await adminCancel(clean(body.id, 100)));
    if (action === 'admin-delete') return send(res, 200, await adminDelete(clean(body.id, 100)));
    if (action === 'admin-complete') return send(res, 200, await adminComplete(clean(body.id, 100), Boolean(body.completed)));
    if (action === 'admin-receive') return send(res, 200, await adminReceive(clean(body.id, 100)));
    if (action === 'admin-custom-delivery') return send(res, 200, await adminCustomDelivery(body));

    return send(res, 400, { ok: false, error: 'Unknown action' });
  } catch (error) {
    console.error('order api error', error);
    const status = error.message === 'UNAUTHORIZED' ? 401 : error.message === 'FORBIDDEN' ? 403 : 400;
    return send(res, status, { ok: false, error: error.message || 'เกิดข้อผิดพลาดในระบบออร์เดอร์' });
  }
};
