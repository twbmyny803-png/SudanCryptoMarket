const express = require("express");
const cors = require("cors");
const { Resend } = require("resend");

const app = express();

app.use(cors());
app.use(express.json());

const resend = new Resend(process.env.RESEND_API_KEY);

// تخزين مؤقت
const otpStore = {};
const users = {};

const RATE_LIMIT_MS = 60 * 1000;
const OTP_EXPIRES_MS = 5 * 60 * 1000;
const PASSWORD_MIN_LENGTH = 8;

// تنظيف البريد
function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

// تنظيف النص
function cleanText(value) {
  return String(value || "").trim();
}

// توليد كود
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// فحص الإيميل
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// فحص الهاتف
function isValidPhone(phone) {
  return /^[0-9]{9,15}$/.test(phone);
}

// فحص كلمة المرور
function isValidPassword(password) {
  return String(password || "").length >= PASSWORD_MIN_LENGTH;
}

// التحقق من الكود
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

// الصفحة الرئيسية
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Sudan Crypto API running"
  });
});

/* ================= إرسال كود ================= */

app.post("/send-code", async (req, res) => {

  try {

    const email = normalizeEmail(req.body.email);
    const purpose = cleanText(req.body.purpose || "register");
    const now = Date.now();

    if (!email) {
      return res.json({
        success: false,
        message: "البريد الإلكتروني مطلوب"
      });
    }

    if (!isValidEmail(email)) {
      return res.json({
        success: false,
        message: "صيغة البريد الإلكتروني غير صحيحة"
      });
    }

    if (purpose === "register" && users[email]) {
      return res.json({
        success: false,
        message: "هذا البريد مسجل مسبقاً"
      });
    }

    if ((purpose === "login" || purpose === "reset") && !users[email]) {
      return res.json({
        success: false,
        message: "الحساب غير موجود"
      });
    }

    const existing = otpStore[email];

    if (existing && existing.lastSentAt && now - existing.lastSentAt < RATE_LIMIT_MS) {

      const secondsLeft =
        Math.ceil((RATE_LIMIT_MS - (now - existing.lastSentAt)) / 1000);

      return res.json({
        success: false,
        message: `انتظر ${secondsLeft} ثانية قبل طلب كود جديد`
      });

    }

    const code = generateOTP();

    otpStore[email] = {
      code,
      purpose,
      expiresAt: now + OTP_EXPIRES_MS,
      lastSentAt: now,
      verified: false
    };

    await resend.emails.send({
      from: "Sudan Crypto <noreply@sudancrypto.com>",
      to: email,
      subject: "رمز التحقق - سودان كربتو",
      html: `
      <h2>رمز التحقق</h2>
      <h1>${code}</h1>
      `
    });

    res.json({
      success: true,
      message: "تم إرسال الكود"
    });

  } catch (error) {

    console.log(error);

    res.json({
      success: false,
      message: "فشل إرسال الكود"
    });

  }

});

/* ================= تحقق من الكود ================= */

app.post("/verify-code", (req, res) => {

  const email = normalizeEmail(req.body.email);
  const code = cleanText(req.body.code);
  const purpose = cleanText(req.body.purpose || "register");

  const saved = otpStore[email];
  const check = isOtpValid(saved, code, purpose);

  if (!check.ok) {
    return res.json({
      success: false,
      message: check.message
    });
  }

  otpStore[email].verified = true;

  res.json({
    success: true,
    message: "تم التحقق"
  });

});

/* ================= تسجيل حساب ================= */

app.post("/register", (req, res) => {

  const name = cleanText(req.body.name);
  const email = normalizeEmail(req.body.email);
  const phone = cleanText(req.body.phone);
  const referral = cleanText(req.body.referral);
  const password = cleanText(req.body.password);

  const saved = otpStore[email];

  if (!saved || saved.purpose !== "register" || saved.verified !== true) {

    return res.json({
      success: false,
      message: "يجب التحقق من البريد الإلكتروني أولاً"
    });

  }

  users[email] = {
    id: Date.now().toString(),
    name,
    email,
    phone,
    referral,
    password,
    createdAt: new Date().toISOString()
  };

  delete otpStore[email];

  res.json({
    success: true,
    message: "تم إنشاء الحساب بنجاح"
  });

});

/* ================= تسجيل الدخول ================= */

app.post("/login", (req, res) => {

  const email = normalizeEmail(req.body.email);
  const password = cleanText(req.body.password);
  const code = cleanText(req.body.code);

  const user = users[email];

  if (!user) {
    return res.json({
      success: false,
      message: "الحساب غير موجود"
    });
  }

  if (user.password !== password) {
    return res.json({
      success: false,
      message: "كلمة السر غير صحيحة"
    });
  }

  const saved = otpStore[email];
  const check = isOtpValid(saved, code, "login");

  if (!check.ok) {
    return res.json({
      success: false,
      message: check.message
    });
  }

  delete otpStore[email];

  res.json({
    success: true,
    message: "تم تسجيل الدخول بنجاح",
    user
  });

});

/* ================= بيانات المستخدم للداشبورد ================= */

app.post("/user-data", (req, res) => {

  const email = normalizeEmail(req.body.email);

  if (!email) {
    return res.json({
      success: false
    });
  }

  const user = users[email];

  if (!user) {
    return res.json({
      success: false
    });
  }

  res.json({
    success: true,
    name: user.name,
    email: user.email,
    phone: user.phone,
    balance: 0,
    dailyIncome: 0,
    operations: []
  });

});

/* ================= عرض المستخدمين ================= */

app.get("/users", (req, res) => {

  res.json({
    success: true,
    users
  });

});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
