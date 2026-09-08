require('dotenv').config();
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

// ─── FIREBASE INIT ────────────────────────────────────────────────────────────
// Prioritas 1: Gunakan serviceAccountKey.json jika ada di root project
// Prioritas 2: Gunakan environment variable FIREBASE_SERVICE_ACCOUNT (JSON string)
// Prioritas 3: Gunakan environment variables terpisah dari .env
let serviceAccount;

const jsonKeyPath = path.join(__dirname, '../serviceAccountKey.json');
if (fs.existsSync(jsonKeyPath)) {
  serviceAccount = require(jsonKeyPath);
  console.log('✅ Firebase: menggunakan serviceAccountKey.json');
} else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
    console.log('✅ Firebase: menggunakan environment variable FIREBASE_SERVICE_ACCOUNT (JSON)');
  } catch (err) {
    console.error('❌ Gagal memproses FIREBASE_SERVICE_ACCOUNT JSON:', err.message);
  }
}

if (!serviceAccount) {
  serviceAccount = {
    type: 'service_account',
    project_id: process.env.FIREBASE_PROJECT_ID,
    private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
    private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    client_id: process.env.FIREBASE_CLIENT_ID,
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
  };
  console.log('✅ Firebase: menggunakan environment variables terpisah');
}

let db;
try {
  if (!admin.apps.length) {
    if (serviceAccount && serviceAccount.project_id && (serviceAccount.private_key || serviceAccount.private_key_id)) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      console.log('✅ Firebase Admin initialized successfully.');
    } else {
      console.warn('⚠️ Firebase: Credentials not found. Please set FIREBASE_SERVICE_ACCOUNT or (FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY) in environment variables.');
    }
  }
  if (admin.apps.length) {
    db = admin.firestore();
  }
} catch (err) {
  console.error('❌ Firebase Admin initialization error:', err.message);
}

// Fallback proxy to provide clear error message if db is accessed before credentials are configured
if (!db) {
  db = new Proxy({}, {
    get(target, prop) {
      if (admin.apps.length) {
        db = admin.firestore();
        return db[prop];
      }
      throw new Error('Firebase credentials missing! Silakan set FIREBASE_SERVICE_ACCOUNT atau (FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY) di Settings > Environment Variables Vercel.');
    }
  });
}

// ─── IN-MEMORY CACHE SYSTEM ──────────────────────────────────────────────────
// Cache sederhana berbasis TTL untuk mengurangi reads Firestore secara drastis.
const _cache = {};

function cacheGet(key) {
  const entry = _cache[key];
  if (!entry) return null;
  if (Date.now() > entry.expireAt) {
    delete _cache[key];
    return null;
  }
  return entry.data;
}

function cacheSet(key, data, ttlSeconds) {
  _cache[key] = {
    data,
    expireAt: Date.now() + (ttlSeconds * 1000),
  };
}

function cacheInvalidate(keyOrPrefix) {
  if (_cache[keyOrPrefix]) {
    delete _cache[keyOrPrefix];
    return;
  }
  for (const k of Object.keys(_cache)) {
    if (k.startsWith(keyOrPrefix)) {
      delete _cache[k];
    }
  }
}

// Cache TTL constants (dalam detik)
const CACHE_TTL = {
  ORDER_STATS: 120,   // 2 menit
  ALL_STOCK: 60,      // 1 menit
  STOCK_COUNT: 60,    // 1 menit
  PRICES: 300,        // 5 menit
  ALL_USERS: 60,      // 1 menit
  USER: 30,           // 30 detik
};

// ─── USERS ────────────────────────────────────────────────────────────────────
async function getUser(telegramId) {
  const cacheKey = `user_${telegramId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const doc = await db.collection('users').doc(String(telegramId)).get();
  if (!doc.exists) return null;
  const data = doc.data();

  // OPTIMIZED: Ambil totalOrders dari field dokumen (bukan query semua orders setiap read)
  const result = {
    ...data,
    saldo: data.saldo !== undefined ? data.saldo : (data.balance !== undefined ? data.balance : 0),
    totalOrders: data.totalOrders !== undefined ? data.totalOrders : 0
  };

  cacheSet(cacheKey, result, CACHE_TTL.USER);
  return result;
}

async function createUser(telegramId, username, firstName) {
  const userData = {
    telegramId: String(telegramId),
    username: username || '',
    firstName: firstName || '',
    saldo: 0,
    totalOrders: 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  await db.collection('users').doc(String(telegramId)).set(userData);
  cacheInvalidate('all_users');
  return userData;
}

async function getUserOrCreate(telegramId, username, firstName) {
  let user = await getUser(telegramId);
  if (!user) user = await createUser(telegramId, username, firstName);
  return user;
}

async function getUserByUsername(username) {
  const cleanedUsername = username.replace(/^@/, '').trim();
  if (!cleanedUsername) return null;

  const snapshot = await db.collection('users')
    .where('username', '==', cleanedUsername)
    .limit(1)
    .get();

  if (snapshot.empty) return null;
  const doc = snapshot.docs[0];
  return getUser(doc.id);
}

async function updateUserSaldo(telegramId, amount) {
  await db.collection('users').doc(String(telegramId)).update({
    saldo: admin.firestore.FieldValue.increment(amount),
    balance: admin.firestore.FieldValue.increment(amount),
  });
  cacheInvalidate(`user_${telegramId}`);
  cacheInvalidate('all_users');
}

// ─── ACCOUNTS (STOCK) ─────────────────────────────────────────────────────────
async function getAvailableAccounts(type, garansi, qty) {
  const snapshot = await db.collection('accounts')
    .where('type', '==', type)
    .where('garansi', '==', garansi)
    .where('status', '==', 'available')
    .limit(qty)
    .get();
  return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function getStockCount(type, garansi) {
  const cacheKey = `stock_count_${type}_${garansi}`;
  const cached = cacheGet(cacheKey);
  if (cached !== null) return cached;

  let count = 0;
  try {
    const countSnap = await db.collection('accounts')
      .where('type', '==', type)
      .where('garansi', '==', garansi)
      .where('status', '==', 'available')
      .count()
      .get();
    count = countSnap.data().count;
  } catch (_) {
    const snapshot = await db.collection('accounts')
      .where('type', '==', type)
      .where('garansi', '==', garansi)
      .where('status', '==', 'available')
      .get();
    count = snapshot.size;
  }

  cacheSet(cacheKey, count, CACHE_TTL.STOCK_COUNT);
  return count;
}

async function getStockItems(type, garansi) {
  const snapshot = await db.collection('accounts')
    .where('type', '==', type)
    .where('garansi', '==', garansi)
    .where('status', '==', 'available')
    .get();
  
  const items = [];
  snapshot.forEach(doc => {
    items.push({ id: doc.id, ...doc.data() });
  });
  return items;
}

async function getAllStock() {
  const cached = cacheGet('all_stock');
  if (cached) return cached;

  const categories = [
    { type: 'muda', garansi: true,  label: 'Akun Tiktok Fresh Usia 0 Day + Garansi' },
    { type: 'muda', garansi: false, label: 'Akun Tiktok Fresh Usia 0 Day + No Garansi' },
    { type: 'tua',  garansi: true,  label: 'Akun Tiktok Fresh Usia 2-8 Day + Garansi' },
    { type: 'tua',  garansi: false, label: 'Akun Tiktok Fresh Usia 2-8 Day + No Garansi' },
  ];
  const result = [];
  for (const cat of categories) {
    const items = await getStockItems(cat.type, cat.garansi);
    result.push({ 
      ...cat, 
      count: items.length, 
      items: items.map(i => ({ 
        id: i.id, 
        fileName: i.fileName || 'Unknown File', 
        createdAt: i.createdAt ? (typeof i.createdAt.toDate === 'function' ? i.createdAt.toDate().toISOString() : i.createdAt) : null 
      })) 
    });
  }

  cacheSet('all_stock', result, CACHE_TTL.ALL_STOCK);
  return result;
}

async function deleteStockCategory(type, garansi) {
  const fs = require('fs');
  const path = require('path');

  const snapshot = await db.collection('accounts')
    .where('type', '==', type)
    .where('garansi', '==', garansi)
    .where('status', '==', 'available')
    .get();

  const batch = db.batch();

  snapshot.docs.forEach(doc => {
    batch.update(doc.ref, {
      status: 'deleted',
      deletedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const data = doc.data();

    // Fallback: hapus dari local jika masih ada storagePath lama
    if (data.storagePath) {
      try {
        const fullPath = path.join(__dirname, '..', data.storagePath);
        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
      } catch (err) {
        console.error('Error deleting local file:', data.storagePath, err.message);
      }
    }
  });

  if (!snapshot.empty) {
    await batch.commit();
  }

  // Invalidate stock cache
  cacheInvalidate('all_stock');
  cacheInvalidate('stock_count');
}

async function markAccountsSold(accountIds) {
  const batch = db.batch();
  accountIds.forEach(id => {
    batch.update(db.collection('accounts').doc(id), {
      status: 'sold',
      soldAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
  await batch.commit();

  // Invalidate stock cache
  cacheInvalidate('all_stock');
  cacheInvalidate('stock_count');
}

async function addAccount(type, garansi, telegramFileId, fileName, storagePath = null, fileHash = '') {
  const result = await db.collection('accounts').add({
    type,
    garansi,
    status: 'available',
    telegramFileId,
    fileName,
    fileHash,
    ...(storagePath ? { storagePath } : {}),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Invalidate stock cache
  cacheInvalidate('all_stock');
  cacheInvalidate('stock_count');
  return result;
}

// ─── ORDERS ───────────────────────────────────────────────────────────────────
async function createOrder(userId, username, type, garansi, qty, totalPrice, paymentUrl, panzzpayInvoiceId, extraData = {}) {
  const orderData = {
    userId: String(userId),
    username: username || '',
    type,
    garansi,
    qty,
    totalPrice,
    paymentUrl: paymentUrl || '',
    panzzpayInvoiceId: panzzpayInvoiceId || '',
    pakasirOrderId: panzzpayInvoiceId || '', // backward compatibility
    status: 'pending',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    ...extraData,
  };
  const ref = await db.collection('orders').add(orderData);
  cacheInvalidate('order_stats');
  return { id: ref.id, ...orderData };
}

async function getOrder(orderId) {
  const doc = await db.collection('orders').doc(orderId).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

async function getOrderByPanzzpayInvoiceId(invoiceId) {
  const snapshot = await db.collection('orders')
    .where('panzzpayInvoiceId', '==', invoiceId)
    .limit(1)
    .get();
  if (!snapshot.empty) {
    const doc = snapshot.docs[0];
    return { id: doc.id, ...doc.data() };
  }
  // Fallback to pakasirOrderId field if existing
  const fallbackSnapshot = await db.collection('orders')
    .where('pakasirOrderId', '==', invoiceId)
    .limit(1)
    .get();
  if (fallbackSnapshot.empty) return null;
  const doc = fallbackSnapshot.docs[0];
  return { id: doc.id, ...doc.data() };
}

async function getOrderByPakasirId(pakasirOrderId) {
  return await getOrderByPanzzpayInvoiceId(pakasirOrderId);
}

async function updateOrderStatus(orderId, status, extra = {}) {
  await db.collection('orders').doc(orderId).update({
    status,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    ...extra,
  });

  // OPTIMIZED: Jika order selesai (done), increment totalOrders user langsung
  if (status === 'done') {
    try {
      const orderDoc = await db.collection('orders').doc(orderId).get();
      if (orderDoc.exists) {
        const userId = String(orderDoc.data().userId);
        await db.collection('users').doc(userId).update({
          totalOrders: admin.firestore.FieldValue.increment(1)
        });
        cacheInvalidate(`user_${userId}`);
        cacheInvalidate('all_users');
      }
    } catch (err) {
      console.error('Error incrementing user totalOrders:', err.message);
    }
  }

  cacheInvalidate('order_stats');
}

async function getAllOrders(limitN = 50) {
  const snapshot = await db.collection('orders')
    .orderBy('createdAt', 'desc')
    .limit(limitN)
    .get();
  return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function getOrderStats() {
  const cached = cacheGet('order_stats');
  if (cached) return cached;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let totalOrders = 0;
  let totalRevenue = 0;
  let todayOrders = 0;
  let todayRevenue = 0;

  // Today stats
  const todaySnapshot = await db.collection('orders')
    .where('status', '==', 'done')
    .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(today))
    .get();
  todaySnapshot.docs.forEach(d => { todayRevenue += d.data().totalPrice || 0; });
  todayOrders = todaySnapshot.size;

  // Total stats dengan count() aggregation
  try {
    const countResult = await db.collection('orders')
      .where('status', '==', 'done')
      .count()
      .get();
    totalOrders = countResult.data().count;

    const totalSnapshot = await db.collection('orders')
      .where('status', '==', 'done')
      .get();
    totalSnapshot.docs.forEach(d => { totalRevenue += d.data().totalPrice || 0; });
  } catch (_) {
    const totalSnapshot = await db.collection('orders')
      .where('status', '==', 'done')
      .get();
    totalOrders = totalSnapshot.size;
    totalSnapshot.docs.forEach(d => { totalRevenue += d.data().totalPrice || 0; });
  }

  const result = {
    todayOrders,
    todayRevenue,
    totalOrders,
    totalRevenue,
  };

  cacheSet('order_stats', result, CACHE_TTL.ORDER_STATS);
  return result;
}

// ─── PRICES ───────────────────────────────────────────────────────────────────
async function getPrices() {
  const cached = cacheGet('prices');
  if (cached) return cached;

  let prices = {
    muda_garansi: 50000,
    muda_no_garansi: 30000,
    tua_garansi: 80000,
    tua_no_garansi: 60000,
  };

  try {
    const doc = await db.collection('settings').doc('prices').get();
    if (doc.exists) {
      prices = { ...prices, ...doc.data() };
    }
  } catch (err) {
    console.error('Error reading prices:', err.message);
  }

  cacheSet('prices', prices, CACHE_TTL.PRICES);
  return prices;
}

async function updatePrices(prices) {
  await db.collection('settings').doc('prices').set(prices, { merge: true });
  cacheInvalidate('prices');
}

function getPriceKey(type, garansi) {
  return `${type}_${garansi ? 'garansi' : 'no_garansi'}`;
}

async function getAllUsers() {
  const cached = cacheGet('all_users');
  if (cached) return cached;

  const usersSnapshot = await db.collection('users').get();

  // OPTIMIZED: Tidak query orders lagi, gunakan totalOrders yang tersimpan di doc user
  const result = usersSnapshot.docs.map(d => {
    const data = d.data();
    const uId = String(data.telegramId || d.id);
    return {
      id: d.id,
      telegramId: uId,
      ...data,
      saldo: data.saldo !== undefined ? data.saldo : (data.balance !== undefined ? data.balance : 0),
      totalOrders: data.totalOrders || 0,
      createdAt: data.createdAt ? (typeof data.createdAt.toDate === 'function' ? data.createdAt.toDate().toISOString() : data.createdAt) : null
    };
  });

  cacheSet('all_users', result, CACHE_TTL.ALL_USERS);
  return result;
}

async function setUserSaldo(telegramId, newSaldo) {
  await db.collection('users').doc(String(telegramId)).update({
    saldo: Number(newSaldo),
    balance: Number(newSaldo)
  });
  cacheInvalidate(`user_${telegramId}`);
  cacheInvalidate('all_users');
}

async function saveHelpTicket(adminMessageId, userId) {
  await db.collection('help_tickets').doc(String(adminMessageId)).set({
    userId: String(userId),
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
}

async function getUserIdFromHelpTicket(adminMessageId) {
  const doc = await db.collection('help_tickets').doc(String(adminMessageId)).get();
  return doc.exists ? doc.data().userId : null;
}

module.exports = {
  db, admin,
  getUser, getUserByUsername, createUser, getUserOrCreate, updateUserSaldo, getAllUsers, setUserSaldo,
  getAvailableAccounts, getStockCount, getStockItems, getAllStock, markAccountsSold, addAccount, deleteStockCategory,
  createOrder, getOrder, getOrderByPanzzpayInvoiceId, getOrderByPakasirId, updateOrderStatus, getAllOrders, getOrderStats,
  getPrices, updatePrices, getPriceKey,
  saveHelpTicket, getUserIdFromHelpTicket,
  cacheGet, cacheSet, cacheInvalidate, CACHE_TTL,
};
