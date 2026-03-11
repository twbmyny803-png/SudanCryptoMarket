const express = require("express");
const cors = require("cors");
const { Resend } = require("resend");

const app = express();

app.use(cors());
app.use(express.json());

const resend = new Resend(process.env.RESEND_API_KEY);

const otpStore = {};
const users = {};

const OTP_EXPIRES_MS = 5 * 60 * 1000;
const PASSWORD_MIN_LENGTH = 8;
const PACKAGE_DURATION_DAYS = 280;

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function cleanText(v) {
  return String(v || "").trim();
}

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isOtpValid(saved, code, purpose) {
  if (!saved) {
    return { ok: false, message: "لم يتم طلب كود" };
  }

  if (saved.purpose !== purpose) {
    return { ok: false, message: "نوع الكود غير صحيح" };
  }

  if (Date.now() > saved.expiresAt) {
    return { ok: false, message: "انتهت صلاحية الكود" };
  }

  if (saved.code !== code) {
    return { ok: false, message: "الكود غير صحيح" };
  }

  return { ok: true };
}

function generateReferralCode(name, email) {
  const part1 = cleanText(name || email || "USR")
    .replace(/\s+/g, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .slice(0, 3) || "USR";

  const part2 = Math.floor(100 + Math.random() * 900).toString();
  return part1 + part2;
}

function getPackageInfo(pack) {
  const p = cleanText(pack).toLowerCase();

  if (p === "starter") {
    return {
      key: "starter",
      name: "Starter",
      price: 50,
      dailyProfit: 2.5,
      durationDays: PACKAGE_DURATION_DAYS
    };
  }

  if (p === "silver") {
    return {
      key: "silver",
      name: "Silver",
      price: 100,
      dailyProfit: 5,
      durationDays: PACKAGE_DURATION_DAYS
    };
  }

  if (p === "gold") {
    return {
      key: "gold",
      name: "Gold",
      price: 250,
      dailyProfit: 8,
      durationDays: PACKAGE_DURATION_DAYS
    };
  }

  if (p === "diamond") {
    return {
      key: "diamond",
      name: "Diamond",
      price: 500,
      dailyProfit: 12,
      durationDays: PACKAGE_DURATION_DAYS
    };
  }

  if (p === "platinum") {
    return {
      key: "platinum",
      name: "Platinum",
      price: 1000,
      dailyProfit: 25,
      durationDays: PACKAGE_DURATION_DAYS
    };
  }

  return null;
}

function calculateProfit(user) {
  if (!user.package || !user.packageStart || !user.packageDurationDays) {
    return 0;
  }

  const daysPassed = Math.floor((Date.now() - user.packageStart) / (1000 * 60 * 60 * 24));
  const payableDays = Math.min(Math.max(daysPassed, 0), user.packageDurationDays);

  return payableDays * (user.dailyProfit || 0);
}

app.get("/", (req, res) => {
  res.json({ success: true, message: "Sudan Crypto API running" });
});

/* ارسال كود */
app.post("/send-code", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const purpose = cleanText(req.body.purpose || "register");
    const now = Date.now();

    if (!email) {
      return res.json({ success: false, message: "البريد مطلوب" });
    }

    if (!isValidEmail(email)) {
      return res.json({ success: false, message: "بريد غير صحيح" });
    }

    if (purpose === "register" && users[email]) {
      return res.json({ success: false, message: "البريد مسجل" });
    }

    if ((purpose === "login" || purpose === "reset") && !users[email]) {
      return res.json({ success: false, message: "الحساب غير موجود" });
    }

    const code = generateOTP();

    otpStore[email] = {
      code,
      purpose,
      expiresAt: now + OTP_EXPIRES_MS,
      verified: false
    };

    await resend.emails.send({
      from: "Sudan Crypto <noreply@sudancrypto.com>",
      to: email,
      subject: "رمز التحقق",
      html: `<h2>${code}</h2>`
    });

    res.json({ success: true });
  } catch (e) {
    console.log(e);
    res.json({ success: false, message: "فشل ارسال الكود" });
  }
});

/* تحقق الكود */
app.post("/verify-code", (req, res) => {
  const email = normalizeEmail(req.body.email);
  const code = cleanText(req.body.code);
  const purpose = cleanText(req.body.purpose || "register");

  const saved = otpStore[email];
  const check = isOtpValid(saved, code, purpose);

  if (!check.ok) {
    return res.json({ success: false, message: check.message });
  }

  otpStore[email].verified = true;

  res.json({ success: true });
});

/* تسجيل مستخدم */
app.post("/register", (req, res) => {
  const name = cleanText(req.body.name);
  const email = normalizeEmail(req.body.email);
  const phone = cleanText(req.body.phone);
  const referral = cleanText(req.body.referral);
  const password = cleanText(req.body.password);

  const saved = otpStore[email];

  if (!saved || saved.purpose !== "register" || saved.verified !== true) {
    return res.json({ success: false, message: "يجب التحقق من البريد" });
  }

  if (!name) {
    return res.json({ success: false, message: "الاسم مطلوب" });
  }

  if (!email || !isValidEmail(email)) {
    return res.json({ success: false, message: "البريد غير صحيح" });
  }

  if (!password || password.length < PASSWORD_MIN_LENGTH) {
    return res.json({ success: false, message: "كلمة السر يجب أن تكون 8 أحرف أو أكثر" });
  }

  let referralCode = generateReferralCode(name, email);

  while (Object.values(users).some(u => u.referralCode === referralCode)) {
    referralCode = generateReferralCode(name, email);
  }

  users[email] = {
    id: Date.now().toString(),
    name,
    email,
    phone,
    referral,
    referredBy: referral || "",
    referralCode,
    password,
    balance: 0,
    operations: [],
    package: null,
    packageName: "",
    packagePrice: 0,
    dailyProfit: 0,
    packageStart: null,
    packageDurationDays: 0,
    createdAt: new Date().toISOString()
  };

  delete otpStore[email];

  res.json({ success: true });
});

/* تسجيل دخول */
app.post("/login", (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = cleanText(req.body.password);
  const code = cleanText(req.body.code);

  const user = users[email];

  if (!user) {
    return res.json({ success: false, message: "الحساب غير موجود" });
  }

  if (user.password !== password) {
    return res.json({ success: false, message: "كلمة السر خطأ" });
  }

  const saved = otpStore[email];
  const check = isOtpValid(saved, code, "login");

  if (!check.ok) {
    return res.json({ success: false, message: check.message });
  }

  delete otpStore[email];

  res.json({ success: true, user });
});

/* شراء باقة مباشرة من الرصيد */
app.post("/buy-package", (req, res) => {
  const email = normalizeEmail(req.body.email);
  const pack = cleanText(req.body.package);

  const user = users[email];

  if (!user) {
    return res.json({ success: false, message: "الحساب غير موجود" });
  }

  const info = getPackageInfo(pack);

  if (!info) {
    return res.json({ success: false, message: "الباقة غير صحيحة" });
  }

  if (user.balance < info.price) {
    return res.json({ success: false, message: "الرصيد غير كافي" });
  }

  user.balance -= info.price;
  user.package = info.key;
  user.packageName = info.name;
  user.packagePrice = info.price;
  user.dailyProfit = info.dailyProfit;
  user.packageStart = Date.now();
  user.packageDurationDays = info.durationDays;

  user.operations.unshift({
    type: "package",
    packageName: info.name,
    amount: info.price,
    dailyProfit: info.dailyProfit,
    durationDays: info.durationDays,
    status: "approved",
    date: new Date().toISOString()
  });

  res.json({ success: true, message: "تم شراء الباقة بنجاح" });
});

/* بيانات المستخدم */
app.post("/user-data", (req, res) => {
  const email = normalizeEmail(req.body.email);
  const user = users[email];

  if (!user) {
    return res.json({ success: false });
  }

  const teamMembers = Object.values(users).filter(u => u.referredBy === user.referralCode);
  const dailyIncome = calculateProfit(user);

  res.json({
    success: true,
    name: user.name,
    email: user.email,
    phone: user.phone,
    balance: user.balance,
    operations: user.operations,
    package: user.package,
    packageName: user.packageName || "",
    packagePrice: user.packagePrice || 0,
    dailyProfitValue: user.dailyProfit || 0,
    packageDurationDays: user.packageDurationDays || 0,
    dailyIncome,
    referralCode: user.referralCode,
    referralCount: teamMembers.length,
    teamMembers: teamMembers.map(member => ({
      name: member.name,
      email: member.email,
      phone: member.phone,
      createdAt: member.createdAt
    }))
  });
});

/* ايداع */
app.post("/deposit", (req, res) => {
  const email = normalizeEmail(req.body.email);
  const amount = Number(req.body.amount);
  const network = cleanText(req.body.network);
  const txid = cleanText(req.body.txid);
  const packageName = cleanText(req.body.packageName);
  const dailyProfit = Number(req.body.dailyProfit || 0);
  const durationDays = Number(req.body.durationDays || 0);

  const user = users[email];

  if (!user) {
    return res.json({ success: false, message: "الحساب غير موجود" });
  }

  if (!network) {
    return res.json({ success: false, message: "اختر الشبكة" });
  }

  if (!amount || amount <= 0) {
    return res.json({ success: false, message: "أدخل مبلغ صحيح" });
  }

  if (!txid) {
    return res.json({ success: false, message: "أدخل رقم العملية TXID" });
  }

  const op = {
    type: packageName ? "package_deposit" : "deposit",
    packageName: packageName || "",
    amount,
    network,
    txid,
    dailyProfit: dailyProfit || 0,
    durationDays: durationDays || 0,
    status: "pending",
    date: new Date().toISOString()
  };

  user.operations.unshift(op);

  res.json({ success: true, message: "تم إرسال الطلب" });
});

/* سحب */
app.post("/withdraw", (req, res) => {
  const email = normalizeEmail(req.body.email);
  const amount = Number(req.body.amount);
  const user = users[email];

  if (!user) {
    return res.json({ success: false });
  }

  if (!amount || amount <= 0) {
    return res.json({ success: false, message: "أدخل مبلغ صحيح" });
  }

  if (user.balance < amount) {
    return res.json({ success: false, message: "الرصيد غير كافي" });
  }

  user.balance -= amount;

  const op = {
    type: "withdraw",
    amount,
    status: "pending",
    date: new Date().toISOString()
  };

  user.operations.unshift(op);

  res.json({ success: true });
});

/* تغيير كلمة السر */
app.post("/reset-password", (req, res) => {
  const email = normalizeEmail(req.body.email);
  const newPassword = cleanText(req.body.password);

  const user = users[email];

  if (!user) {
    return res.json({ success: false });
  }

  const saved = otpStore[email];

  if (!saved || saved.purpose !== "reset" || saved.verified !== true) {
    return res.json({ success: false, message: "تحقق من الكود" });
  }

  user.password = newPassword;
  delete otpStore[email];

  res.json({ success: true });
});

/* المستخدمين */
app.get("/users", (req, res) => {
  res.json({ success: true, users });
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
