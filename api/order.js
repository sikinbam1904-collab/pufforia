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

  if (decoded.uid !== ADMIN_UID) {
    throw new Error('FORBIDDEN');
  }

  return decoded;
}

async function getOrderWithDeliveries(token) {
  const ref = db().collection('orders_cakee').doc(token);
  const snap = await ref.get();

  if (!snap.exists) return null;

  const deliveriesSnap = await ref.collection('deliveries').get();

  const deliveries = deliveriesSnap.docs.map(d => ({
    id: d.id,
    ...d.data()
  }));

  return {
    id: snap.id,
    ...snap.data(),
    deliveries
  };
}

function makeOrderToken() {
  return crypto.randomBytes(24).toString('hex');
}

async function createOrder(body) {
  const itemsInput = Array.isArray(body.items) ? body.items : [];

  if (!itemsInput.length || itemsInput.length > 20) {
    throw new Error('รายการสินค้าไม่ถูกต้อง');
  }

  const normalized = itemsInput.map(item => ({
    productId: clean(item.productId, 200),
    qty: Number(item.qty)
  }));

  if (
    normalized.some(
      x =>
        !x.productId ||
        !Number.isInteger(x.qty) ||
        x.qty < 1 ||
        x.qty > 20
    )
  ) {
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

    for (const line of normalized) {
      const productRef = db()
        .collection('products_cakee')
        .doc(line.productId);

      const snap = await tx.get(productRef);

      if (!snap.exists) {
        throw new Error('ไม่พบสินค้า');
      }

      const product = snap.data() || {};

      const priceCents = Math.round(Number(product.priceBaht) * 100);

      if (!Number.isInteger(priceCents) || priceCents <= 0) {
        throw new Error('ราคาสินค้าไม่ถูกต้อง');
      }

      if (product.soldOut) {
        throw new Error(`${product.title || 'สินค้า'} หมดชั่วคราวค่ะ`);
      }

      if (product.deliveryType === 'code') {
        const stock = Number(product.stockCount);

        if (!Number.isInteger(stock) || stock < line.qty) {
          throw new Error(
            `${product.title || 'สินค้า'} เหลือสินค้า ${
              Number.isInteger(stock) ? stock : 0
            } ชิ้นค่ะ`
          );
        }
      }

      totalCents += priceCents * line.qty;

      if (totalCents > 999999900) {
        throw new Error('ยอดออร์เดอร์สูงเกินกำหนด');
      }

      items.push({
        productId: line.productId,
        title: clean(product.title || 'สินค้า', 120),
        qty: line.qty,
        priceCents,
        deliveryType: product.deliveryType || 'custom'
      });
    }

    const order = {
      orderNo: 'AM-' + token.slice(0, 8).toUpperCase(),
      name: clean(body.name, 120),
      contact: clean(body.contact, 120),
      email: clean(body.email, 200),
      note: clean(body.note, 1000),
      items,
      totalCents,
      status: 'awaiting_slip',
      createdAt: FieldValue.serverTimestamp()
    };

    tx.create(orderRef, order);

    result = {
      token,
      orderNo: order.orderNo,
      accessCode: token.slice(8).toUpperCase()
    };
  });

  return result;
}

async function verifyEasySlip(image, order) {
  const apiKey = String(
    process.env.EASYSLIP_API_KEY || ''
  ).trim();

  if (!apiKey) {
    throw new Error('EASYSLIP_NOT_CONFIGURED');
  }

  const matchAccount =
    String(
      process.env.EASYSLIP_MATCH_ACCOUNT || ''
    ).toLowerCase() === 'true';

  const amountBaht = Number(order.totalCents) / 100;

  const payload = {
    base64: image,
    remark: clean(order.orderNo || '', 255),
    matchAmount: amountBaht,
    checkDuplicate: true
  };

  if (matchAccount) {
    payload.matchAccount = true;
  }

  const response = await fetch(
    'https://api.easyslip.com/v2/verify/bank',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    }
  );

  const result = await response.json().catch(() => ({}));

  if (!response.ok || !result.success) {
    const code =
      result?.error?.code || `HTTP_${response.status}`;

    const message =
      result?.error?.message ||
      'EasySlip ตรวจสลิปไม่สำเร็จ';

    const error = new Error(message);
    error.code = code;

    throw error;
  }

  const data = result.data || {};

  const amountInSlip = Number(
    data.amountInSlip ??
    data.rawSlip?.amount?.amount
  );

  const amountMatched =
    data.isAmountMatched === true ||
    (
      Number.isFinite(amountInSlip) &&
      amountInSlip === amountBaht
    );

  const accountMatched =
    !matchAccount ||
    data.matchedAccount != null;

  if (data.isDuplicate === true) {
    const error = new Error(
      'สลิปนี้เคยถูกตรวจสอบแล้วค่ะ'
    );

    error.code = 'DUPLICATE_SLIP';

    throw error;
  }

  if (!amountMatched) {
    const error = new Error(
      `ยอดในสลิปไม่ตรงกับยอดออร์เดอร์ค่ะ (${
        Number.isFinite(amountInSlip)
          ? amountInSlip.toFixed(2)
          : '-'
      } บาท)`
    );

    error.code = 'AMOUNT_MISMATCH';

    throw error;
  }

  if (!accountMatched) {
    const error = new Error(
      'บัญชีผู้รับในสลิปไม่ตรงกับบัญชีร้านที่ลงทะเบียนกับ EasySlip ค่ะ'
    );

    error.code = 'ACCOUNT_MISMATCH';

    throw error;
  }

  return {
    data,
    message:
      result.message ||
      'Bank slip verified successfully'
  };
}

async function saveSubmittedSlip(
  token,
  image,
  verification = {}
) {
  const orderRef =
    db().collection('orders_cakee').doc(token);

  const slipRef =
    db().collection('order_slips_cakee').doc(token);

  await db().runTransaction(async tx => {
    const snap = await tx.get(orderRef);

    if (!snap.exists) {
      throw new Error('ไม่พบออร์เดอร์ค่ะ');
    }

    const order = snap.data() || {};

    if (
      !['awaiting_slip', 'rejected'].includes(
        order.status
      )
    ) {
      throw new Error(
        'ออร์เดอร์นี้ไม่สามารถส่งสลิปซ้ำได้'
      );
    }

    tx.set(slipRef, {
      image,
      imageHost: 'base64',
      submittedAt:
        FieldValue.serverTimestamp(),

      verificationStatus:
        verification.status || 'pending',

      verificationCode:
        clean(
          verification.code || '',
          80
        ),

      verificationMessage:
        clean(
          verification.message || '',
          500
        ),

      verifiedAt:
        verification.status === 'verified'
          ? FieldValue.serverTimestamp()
          : FieldValue.delete(),

      easySlipData:
        verification.data ||
        FieldValue.delete()
    });

    tx.update(orderRef, {
      status: 'submitted'
    });
  });
}

async function submitSlip(body) {
  const token = clean(body.token, 100);

  if (!validToken(token)) {
    throw new Error(
      'รหัสออร์เดอร์ไม่ถูกต้อง'
    );
  }

  const image = String(body.image || '');

  if (!validSlipImage(image)) {
    throw new Error(
      'ไฟล์สลิปต้องเป็น JPG, PNG หรือ WebP และมีขนาดไม่เกิน 700 KB'
    );
  }

  const order =
    await getOrderWithDeliveries(token);

  if (!order) {
    throw new Error('ไม่พบออร์เดอร์ค่ะ');
  }

  if (
    !['awaiting_slip', 'rejected'].includes(
      order.status
    )
  ) {
    throw new Error(
      'ออร์เดอร์นี้ไม่สามารถส่งสลิปซ้ำได้'
    );
  }

  try {
    const verification =
      await verifyEasySlip(
        image,
        order
      );

    await saveSubmittedSlip(
      token,
      image,
      {
        status: 'verified',
        code: '',
        message: verification.message,
        data: verification.data
      }
    );

    try {
      await adminApprove(token);

      return {
        ok: true,
        verified: true,
        message:
          'ตรวจสลิปสำเร็จและยืนยันการชำระเงินแล้วค่ะ'
      };
    } catch (approvalError) {
      console.error(
        'EasySlip verified but automatic fulfillment failed',
        approvalError
      );

      return {
        ok: true,
        verified: true,
        manualReview: true,
        message:
          'ตรวจสลิปผ่านแล้ว แต่ระบบส่งสินค้าอัตโนมัติไม่สำเร็จ กรุณาให้แอดมินตรวจออร์เดอร์ค่ะ'
      };
    }
  } catch (error) {
    console.error(
      'EasySlip verification failed',
      error
    );

    const code =
      error.code || 'EASYSLIP_ERROR';

    const manualReviewCodes =
      new Set([
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
      await saveSubmittedSlip(
        token,
        image,
        {
          status: 'manual_review',
          code,
          message: error.message
        }
      );

      return {
        ok: true,
        verified: false,
        manualReview: true,
        message:
          'ส่งสลิปแล้วค่ะ ระบบตรวจอัตโนมัติขัดข้อง จึงส่งให้แอดมินตรวจสอบค่ะ'
      };
    }

    throw error;
  }
}

/* =========================================================
   ยอดขาย + กิจกรรมล่าสุด
   ========================================================= */

async function recentSales() {
  const snap = await db()
    .collection('orders_cakee')
    .orderBy('createdAt', 'desc')
    .limit(500)
    .get();

  const paid = snap.docs
    .map(d => ({
      id: d.id,
      ...d.data()
    }))
    .filter(order => order.status === 'paid');

  let soldItems = 0;
  let totalCents = 0;

  for (const order of paid) {
    totalCents +=
      Number(order.totalCents) || 0;

    for (
      const item of (
        Array.isArray(order.items)
          ? order.items
          : []
      )
    ) {
      soldItems +=
        Number(item.qty) || 0;
    }
  }

  function maskName(name) {
    const value = clean(name, 120);

    if (!value) return 'ลูกค้า';

    const chars = Array.from(value);

    if (chars.length <= 2) {
      return chars[0] + '*';
    }

    return (
      chars.slice(0, 2).join('') +
      '*'.repeat(
        Math.min(
          chars.length - 2,
          6
        )
      )
    );
  }

  const recent = [];

  for (const order of paid.slice(0, 20)) {
    const createdAtMillis =
      typeof order.createdAt?.toMillis ===
      'function'
        ? order.createdAt.toMillis()
        : null;

    const items = Array.isArray(order.items)
      ? order.items
      : [];

    recent.push({
      customer: maskName(order.name),

      products: items.map(item => ({
        title: clean(
          item.title || 'สินค้า',
          120
        ),

        qty: Number(item.qty) || 0
      })),

      createdAt: createdAtMillis
    });
  }

  return {
    ok: true,

    sales: {
      soldItems,
      totalCents,
      orders: paid.length
    },

    recent
  };
}

/* =========================================================
   ADMIN LIST
   ========================================================= */

async function adminList() {
  const snap = await db()
    .collection('orders_cakee')
    .orderBy('createdAt', 'desc')
    .limit(300)
    .get();

  return snap.docs.map(d => ({
    id: d.id,
    ...d.data()
  }));
}

async function adminSlip(id) {
  if (!validToken(id)) {
    throw new Error(
      'รหัสออร์เดอร์ไม่ถูกต้อง'
    );
  }

  const snap =
    await db()
      .collection('order_slips_cakee')
      .doc(id)
      .get();

  if (!snap.exists) {
    throw new Error(
      'ลูกค้ายังไม่ได้ส่งสลิป'
    );
  }

  return {
    id: snap.id,
    ...snap.data()
  };
}

async function adminApprove(id) {
  if (!validToken(id)) {
    throw new Error(
      'รหัสออร์เดอร์ไม่ถูกต้อง'
    );
  }

  const orderRef =
    db().collection('orders_cakee').doc(id);

  const slipRef =
    db().collection('order_slips_cakee').doc(id);

  await db().runTransaction(async tx => {
    const orderSnap =
      await tx.get(orderRef);

    const slipSnap =
      await tx.get(slipRef);

    if (
      !orderSnap.exists ||
      orderSnap.data().status !== 'submitted' ||
      !slipSnap.exists
    ) {
      throw new Error(
        'ออร์เดอร์หรือสลิปไม่พร้อม'
      );
    }

    const order =
      orderSnap.data();

    const items =
      Array.isArray(order.items)
        ? order.items
        : [];

    if (
      !items.length ||
      items.length > 20 ||
      items.some(
        item =>
          !Number.isInteger(item.qty) ||
          item.qty < 1 ||
          item.qty > 20 ||
          !Number.isInteger(item.priceCents) ||
          item.priceCents < 1
      )
    ) {
      throw new Error(
        'ข้อมูลสินค้าในออร์เดอร์ไม่ถูกต้อง'
      );
    }

    if (
      new Set(
        items.map(
          item => item.productId
        )
      ).size !== items.length ||
      items.reduce(
        (sum, item) =>
          sum +
          item.qty *
          item.priceCents,
        0
      ) !== order.totalCents
    ) {
      throw new Error(
        'ยอดสินค้าไม่ตรง กรุณาตรวจออร์เดอร์'
      );
    }

    const productSnaps = [];
    const stockSnaps = [];

    for (const item of items) {
      productSnaps.push(
        await tx.get(
          db()
            .collection(
              'products_cakee'
            )
            .doc(item.productId)
        )
      );

      stockSnaps.push(
        item.deliveryType ===
        'custom'
          ? null
          : await tx.get(
              db()
                .collection(
                  'product_delivery_cakee'
                )
                .doc(item.productId)
            )
      );
    }

    items.forEach(
      (item, index) => {
        const product =
          productSnaps[index].data();

        if (
          !product ||
          clean(
            product.title ||
              'สินค้า',
            120
          ) !== item.title ||
          Math.round(
            Number(
              product.priceBaht
            ) * 100
          ) !== item.priceCents ||
          (
            product.deliveryType ||
            'custom'
          ) !== item.deliveryType
        ) {
          throw new Error(
            'ราคาหรือประเภทสินค้ามีการแก้ไข กรุณาตรวจสอบก่อนยืนยัน'
          );
        }

        const stock =
          stockSnaps[index]?.data();

        if (
          item.deliveryType ===
          'file'
        ) {
          if (!stock?.fileData) {
            throw new Error(
              'ยังไม่มีไฟล์สำหรับ ' +
              item.title
            );
          }

          tx.set(
            orderRef
              .collection(
                'deliveries'
              )
              .doc(item.productId),
            {
              fileData:
                stock.fileData,

              fileName:
                stock.fileName ||
                'สินค้า',

              deliveredAt:
                FieldValue.serverTimestamp()
            }
          );
        }

        if (
          item.deliveryType ===
          'code'
        ) {
          if (
            !stock ||
            !Array.isArray(
              stock.codes
            ) ||
            stock.codes.length <
              item.qty
          ) {
            throw new Error(
              'โค้ดของ ' +
              item.title +
              ' ไม่พอ'
            );
          }

          tx.set(
            orderRef
              .collection(
                'deliveries'
              )
              .doc(item.productId),
            {
              codes:
                stock.codes.slice(
                  0,
                  item.qty
                ),

              deliveredAt:
                FieldValue.serverTimestamp()
            }
          );

          tx.update(
            stockSnaps[index].ref,
            {
              codes:
                stock.codes.slice(
                  item.qty
                )
            }
          );

          tx.update(
            productSnaps[index].ref,
            {
              stockCount:
                stock.codes.length -
                item.qty
            }
          );
        }
      }
    );

    tx.update(
      orderRef,
      {
        status: 'paid',
        paidAt:
          FieldValue.serverTimestamp()
      }
    );
  });

  return {
    ok: true
  };
}

async function adminCustomDelivery(body) {
  const id = clean(body.id, 100);
  const productId =
    clean(body.productId, 200);

  if (
    !validToken(id) ||
    !productId
  ) {
    throw new Error(
      'ข้อมูลการส่งงานไม่ถูกต้อง'
    );
  }

  const orderRef =
    db().collection('orders_cakee').doc(id);

  const orderSnap =
    await orderRef.get();

  if (!orderSnap.exists) {
    throw new Error(
      'ไม่พบออร์เดอร์ค่ะ'
    );
  }

  const order =
    orderSnap.data() || {};

  if (order.status !== 'paid') {
    throw new Error(
      'ต้องยืนยันชำระเงินก่อนจึงจะส่งงานได้ค่ะ'
    );
  }

  const item =
    Array.isArray(order.items)
      ? order.items.find(
          x =>
            String(
              x.productId
            ) === productId
        )
      : null;

  if (!item) {
    throw new Error(
      'สินค้านี้ไม่ได้อยู่ในออร์เดอร์ค่ะ'
    );
  }

  if (
    item.deliveryType !==
    'custom'
  ) {
    throw new Error(
      'สินค้านี้ไม่ใช่สินค้าที่ส่งงานแบบกำหนดเองค่ะ'
    );
  }

  const text =
    clean(body.text, 5000);

  const fileData =
    String(body.fileData || '');

  const cloudinaryPublicId =
    clean(
      body.cloudinaryPublicId,
      500
    );

  const imageHost =
    clean(body.imageHost, 500);

  const fileName =
    clean(body.fileName, 255);

  if (!text && !fileData) {
    throw new Error(
      'กรุณาใส่ข้อความหรือเลือกไฟล์ค่ะ'
    );
  }

  if (fileData.length > 450 * 1024) {
    throw new Error(
      'ไฟล์ส่งงานใหญ่เกิน 450 KB ค่ะ'
    );
  }

  if (
    imageHost &&
    ![
      'cloudinary',
      'inline'
    ].includes(imageHost)
  ) {
    throw new Error(
      'แหล่งไฟล์ส่งงานไม่ถูกต้องค่ะ'
    );
  }

  await orderRef
    .collection('deliveries')
    .doc(productId)
    .set({
      text,
      fileData,
      cloudinaryPublicId,
      imageHost,
      fileName,
      deliveredAt:
        FieldValue.serverTimestamp()
    });

  return {
    ok: true
  };
}

async function adminReject(id) {
  if (!validToken(id)) {
    throw new Error(
      'รหัสออร์เดอร์ไม่ถูกต้อง'
    );
  }

  const ref =
    db().collection('orders_cakee').doc(id);

  await db().runTransaction(
    async tx => {
      const snap =
        await tx.get(ref);

      if (!snap.exists) {
        throw new Error(
          'ไม่พบออร์เดอร์ค่ะ'
        );
      }

      if (
        snap.data().status !==
        'submitted'
      ) {
        throw new Error(
          'ออร์เดอร์นี้ไม่อยู่ในสถานะรอตรวจสลิปค่ะ'
        );
      }

      tx.update(
        ref,
        {
          status: 'rejected',
          rejectedAt:
            FieldValue.serverTimestamp()
        }
      );
    }
  );

  return {
    ok: true
  };
}

async function adminCancel(id) {
  if (!validToken(id)) {
    throw new Error(
      'รหัสออร์เดอร์ไม่ถูกต้อง'
    );
  }

  const ref =
    db().collection('orders_cakee').doc(id);

  await db().runTransaction(
    async tx => {
      const snap =
        await tx.get(ref);

      if (
        !snap.exists ||
        snap.data().status ===
          'cancelled'
      ) {
        throw new Error(
          'ออร์เดอร์นี้ถูกลบหรือยกเลิกแล้ว'
        );
      }

      tx.update(
        ref,
        {
          status: 'cancelled',
          cancelledAt:
            FieldValue.serverTimestamp()
        }
      );
    }
  );

  return {
    ok: true
  };
}

async function adminDelete(id) {
  if (!validToken(id)) {
    throw new Error(
      'รหัสออร์เดอร์ไม่ถูกต้อง'
    );
  }

  const ref =
    db().collection('orders_cakee').doc(id);

  const deliveries =
    await ref
      .collection('deliveries')
      .get();

  const batch =
    db().batch();

  deliveries.docs.forEach(
    d => batch.delete(d.ref)
  );

  batch.delete(
    db()
      .collection(
        'order_slips_cakee'
      )
      .doc(id)
  );

  batch.delete(ref);

  await batch.commit();

  return {
    ok: true
  };
}

async function adminReceive(id) {
  if (!validToken(id)) {
    throw new Error(
      'รหัสออร์เดอร์ไม่ถูกต้อง'
    );
  }

  const ref =
    db().collection('orders_cakee').doc(id);

  await db().runTransaction(
    async tx => {
      const snap =
        await tx.get(ref);

      if (!snap.exists) {
        throw new Error(
          'ไม่พบออร์เดอร์ค่ะ'
        );
      }

      const order =
        snap.data() || {};

      if (
        order.orderNo !==
        'AM-' +
          id
            .slice(0, 8)
            .toUpperCase()
      ) {
        throw new Error(
          'เลขออร์เดอร์ไม่ตรงกันค่ะ'
        );
      }

      if (
        order.status !==
        'paid'
      ) {
        throw new Error(
          'ออร์เดอร์นี้ยังไม่ได้รับการยืนยันชำระเงินค่ะ'
        );
      }

      if (order.receivedAt) {
        throw new Error(
          'ออร์เดอร์นี้รับสินค้าไปแล้วค่ะ'
        );
      }

      tx.update(
        ref,
        {
          receivedAt:
            FieldValue.serverTimestamp(),
          receivedBy:
            ADMIN_UID
        }
      );
    }
  );

  return {
    ok: true
  };
}

async function adminComplete(
  id,
  completed
) {
  if (!validToken(id)) {
    throw new Error(
      'รหัสออร์เดอร์ไม่ถูกต้อง'
    );
  }

  const ref =
    db().collection('orders_cakee').doc(id);

  await db().runTransaction(
    async tx => {
      const snap =
        await tx.get(ref);

      if (!snap.exists) {
        throw new Error(
          'ไม่พบออร์เดอร์ค่ะ'
        );
      }

      const order =
        snap.data() || {};

      if (
        order.status !==
        'paid'
      ) {
        throw new Error(
          'ต้องยืนยันชำระเงินก่อนจึงจะปิดงานได้ค่ะ'
        );
      }

      if (completed) {
        const items =
          Array.isArray(order.items)
            ? order.items
            : [];

        const needsReceive =
          items.some(
            item =>
              item.deliveryType !==
              'custom'
          );

        if (
          needsReceive &&
          !order.receivedAt
        ) {
          throw new Error(
            'ออร์เดอร์นี้ยังไม่ได้รับสินค้าโดยลูกค้าค่ะ'
          );
        }

        const customItems =
          items.filter(
            item =>
              item.deliveryType ===
              'custom'
          );

        if (customItems.length) {
          const missing = [];

          for (
            const item of customItems
          ) {
            const deliverySnap =
              await tx.get(
                ref
                  .collection(
                    'deliveries'
                  )
                  .doc(
                    item.productId
                  )
              );

            const delivery =
              deliverySnap.data() ||
              {};

            if (
              !deliverySnap.exists ||
              (
                !delivery.text &&
                !delivery.fileData
              )
            ) {
              missing.push(
                item.title ||
                item.productId
              );
            }
          }

          if (missing.length) {
            throw new Error(
              'ยังส่งงานไม่ครบ: ' +
              missing.join(', ')
            );
          }
        }
      }

      tx.update(
        ref,
        {
          completedAt:
            completed
              ? FieldValue.serverTimestamp()
              : FieldValue.delete()
        }
      );
    }
  );

  return {
    ok: true
  };
}

module.exports = async (
  req,
  res
) => {
  if (req.method !== 'POST') {
    return send(
      res,
      405,
      {
        ok: false,
        error: 'Method not allowed'
      }
    );
  }

  try {
    const body =
      req.body || {};

    const action =
      clean(body.action, 50);

    if (
      action === 'create'
    ) {
      return send(
        res,
        200,
        {
          ok: true,
          ...(await createOrder(body))
        }
      );
    }

    if (
      action === 'lookup'
    ) {
      const token =
        clean(body.token, 100);

      if (!validToken(token)) {
        return send(
          res,
          400,
          {
            ok: false,
            error:
              'รหัสออร์เดอร์ไม่ถูกต้อง'
          }
        );
      }

      const order =
        await getOrderWithDeliveries(
          token
        );

      if (
        !order ||
        order.orderNo !==
          'AM-' +
            token
              .slice(0, 8)
              .toUpperCase()
      ) {
        return send(
          res,
          404,
          {
            ok: false,
            error:
              'ไม่พบออร์เดอร์ค่ะ'
          }
        );
      }

      return send(
        res,
        200,
        {
          ok: true,
          order
        }
      );
    }

    if (
      action === 'submit-slip'
    ) {
      return send(
        res,
        200,
        await submitSlip(body)
      );
    }

    /* สำคัญ: endpoint ใหม่สำหรับยอดขาย/กิจกรรม */
    if (
      action === 'recent-sales'
    ) {
      return send(
        res,
        200,
        await recentSales()
      );
    }

    await requireAdmin(req);

    if (
      action === 'admin-list'
    ) {
      return send(
        res,
        200,
        {
          ok: true,
          orders:
            await adminList()
        }
      );
    }

    if (
      action === 'admin-slip'
    ) {
      return send(
        res,
        200,
        {
          ok: true,
          slip:
            await adminSlip(
              clean(body.id, 100)
            )
        }
      );
    }

    if (
      action === 'admin-approve'
    ) {
      return send(
        res,
        200,
        await adminApprove(
          clean(body.id, 100)
        )
      );
    }

    if (
      action === 'admin-reject'
    ) {
      return send(
        res,
        200,
        await adminReject(
          clean(body.id, 100)
        )
      );
    }

    if (
      action === 'admin-cancel'
    ) {
      return send(
        res,
        200,
        await adminCancel(
          clean(body.id, 100)
        )
      );
    }

    if (
      action === 'admin-delete'
    ) {
      return send(
        res,
        200,
        await adminDelete(
          clean(body.id, 100)
        )
      );
    }

    if (
      action === 'admin-complete'
    ) {
      return send(
        res,
        200,
        await adminComplete(
          clean(body.id, 100),
          Boolean(body.completed)
        )
      );
    }

    if (
      action === 'admin-receive'
    ) {
      return send(
        res,
        200,
        await adminReceive(
          clean(body.id, 100)
        )
      );
    }

    if (
      action ===
      'admin-custom-delivery'
    ) {
      return send(
        res,
        200,
        await adminCustomDelivery(
          body
        )
      );
    }

    return send(
      res,
      400,
      {
        ok: false,
        error: 'Unknown action'
      }
    );
  } catch (error) {
    console.error(
      'order api error',
      error
    );

    const status =
      error.message ===
      'UNAUTHORIZED'
        ? 401
        : error.message ===
          'FORBIDDEN'
          ? 403
          : 400;

    return send(
      res,
      status,
      {
        ok: false,
        error:
          error.message ||
          'เกิดข้อผิดพลาดในระบบออร์เดอร์'
      }
    );
  }
};
