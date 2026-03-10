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

const RATE_LIMIT_MS = 60 * 1000; // 60 ثانية
const OTP_EXPIRES_MS = 5 * 60 * 1000; // 5 دقائق
const PASSWORD_MIN_LENGTH = 8;

// تنظيف البريد
function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

// تنظيف النص
function cleanText(value) {
  return String(value || "").trim();
}

// توليد كود 6 أرقام
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// فحص الإيميل
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// فحص الهاتف السوداني بشكل بسيط
function isValidPhone(phone) {
  return /^[0-9]{9,15}$/.test(phone);
}

// فحص كلمة المرور
function isValidPassword(password) {
  return String(password || "").length >= PASSWORD_MIN_LENGTH;
}

// التحقق هل الكود صالح
function isOtpValid(saved, code, purpose) {
  if (!saved) return { ok: false, message: "لم يتم طلب كود" };

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

// إرسال كود عام حسب الغرض
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

    // التحقق حسب الغرض
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
      const secondsLeft = Math.ceil((RATE_LIMIT_MS - (now - existing.lastSentAt)) / 1000);

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

    let subject = "رمز التحقق - سودان كربتو";
    let title = "سودان كربتو";
    let text = "رمز التحقق الخاص بك هو:";

    if (purpose === "login") {
      subject = "رمز تسجيل الدخول - سودان كربتو";
      text = "رمز تسجيل الدخول الخاص بك هو:";
    }

    if (purpose === "reset") {
      subject = "إعادة تعيين كلمة السر - سودان كربتو";
      text = "رمز إعادة تعيين كلمة السر هو:";
    }

    await resend.emails.send({
      from: "Sudan Crypto <noreply@sudancrypto.com>",
      to: email,
      subject,
      html: `
        <div style="font-family: Arial, sans-serif; direction: rtl; text-align: right; background:#f7f9fc; padding:24px;">
          <div style="max-width:520px; margin:0 auto; background:#ffffff; border-radius:14px; padding:28px; border:1px solid #e6ecf5;">
            <h2 style="margin:0 0 12px; color:#2D6AF6;">${title}</h2>
            <p style="font-size:16px; color:#1A1A1A; margin:0 0 14px;">${text}</p>
            <div style="font-size:34px; font-weight:bold; letter-spacing:6px; color:#2D6AF6; margin:20px 0; text-align:center;">
              ${code}
            </div>
            <p style="font-size:14px; color:#444; margin:0 0 10px;">ينتهي هذا الرمز خلال 5 دقائق.</p>
            <p style="font-size:14px; color:#444; margin:0;">إذا لم تطلب هذا الرمز يمكنك تجاهل الرسالة.</p>
          </div>
        </div>
      `
    });

    return res.json({
      success: true,
      message: "تم إرسال الكود"
    });
  } catch (error) {
    console.error("Send code error:", error);

    return res.json({
      success: false,
      message: "فشل إرسال الكود"
    });
  }
});

// التحقق من الكود فقط
app.post("/verify-code", (req, res) => {
  const email = normalizeEmail(req.body.email);
  const code = cleanText(req.body.code);
  const purpose = cleanText(req.body.purpose || "register");

  if (!email || !code) {
    return res.json({
      success: false,
      message: "البريد الإلكتروني والكود مطلوبان"
    });
  }

  const saved = otpStore[email];
  const check = isOtpValid(saved, code, purpose);

  if (!check.ok) {
    return res.json({
      success: false,
      message: check.message
    });
  }

  otpStore[email].verified = true;

  return res.json({
    success: true,
    message: "تم التحقق بنجاح"
  });
});

// تسجيل حساب جديد
app.post("/register", (req, res) => {
  const name = cleanText(req.body.name);
  const email = normalizeEmail(req.body.email);
  const phone = cleanText(req.body.phone);
  const referral = cleanText(req.body.referral);
  const password = cleanText(req.body.password);

  if (!name) {
    return res.json({
      success: false,
      message: "الاسم الحقيقي مطلوب"
    });
  }

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

  if (!phone) {
    return res.json({
      success: false,
      message: "رقم الهاتف مطلوب"
    });
  }

  if (!isValidPhone(phone)) {
    return res.json({
      success: false,
      message: "رقم الهاتف غير صحيح"
    });
  }

  if (!password) {
    return res.json({
      success: false,
      message: "كلمة المرور مطلوبة"
    });
  }

  if (!isValidPassword(password)) {
    return res.json({
      success: false,
      message: "كلمة المرور يجب أن تكون 8 أحرف أو أكثر"
    });
  }

  if (users[email]) {
    return res.json({
      success: false,
      message: "هذا البريد مسجل مسبقاً"
    });
  }

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
    emailVerified: true,
    createdAt: new Date().toISOString()
  };

  delete otpStore[email];

  return res.json({
    success: true,
    message: "تم إنشاء الحساب بنجاح",
    user: {
      id: users[email].id,
      name: users[email].name,
      email: users[email].email,
      phone: users[email].phone,
      referral: users[email].referral,
      createdAt: users[email].createdAt
    }
  });
});

// تسجيل الدخول: كلمة السر + كود الإيميل
app.post("/login", (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = cleanText(req.body.password);
  const code = cleanText(req.body.code);

  if (!email) {
    return res.json({
      success: false,
      message: "البريد الإلكتروني مطلوب"
    });
  }

  if (!password) {
    return res.json({
      success: false,
      message: "كلمة المرور مطلوبة"
    });
  }

  if (!code) {
    return res.json({
      success: false,
      message: "كود التحقق مطلوب"
    });
  }

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

  return res.json({
    success: true,
    message: "تم تسجيل الدخول بنجاح",
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      referral: user.referral,
      createdAt: user.createdAt
    }
  });
});

// طلب كود نسيان كلمة السر
app.post("/forgot-password", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const now = Date.now();

    if (!email) {
      return res.json({
        success: false,
        message: "البريد الإلكتروني مطلوب"
      });
    }

    if (!users[email]) {
      return res.json({
        success: false,
        message: "الحساب غير موجود"
      });
    }

    const existing = otpStore[email];
    if (existing && existing.lastSentAt && now - existing.lastSentAt < RATE_LIMIT_MS) {
      const secondsLeft = Math.ceil((RATE_LIMIT_MS - (now - existing.lastSentAt)) / 1000);

      return res.json({
        success: false,
        message: `انتظر ${secondsLeft} ثانية قبل طلب كود جديد`
      });
    }

    const code = generateOTP();

    otpStore[email] = {
      code,
      purpose: "reset",
      expiresAt: now + OTP_EXPIRES_MS,
      lastSentAt: now,
      verified: false
    };

    await resend.emails.send({
      from: "Sudan Crypto <noreply@sudancrypto.com>",
      to: email,
      subject: "إعادة تعيين كلمة السر - سودان كربتو",
      html: `
        <div style="font-family: Arial, sans-serif; direction: rtl; text-align: right; background:#f7f9fc; padding:24px;">
          <div style="max-width:520px; margin:0 auto; background:#ffffff; border-radius:14px; padding:28px; border:1px solid #e6ecf5;">
            <h2 style="margin:0 0 12px; color:#2D6AF6;">سودان كربتو</h2>
            <p style="font-size:16px; color:#1A1A1A; margin:0 0 14px;">رمز إعادة تعيين كلمة السر هو:</p>
            <div style="font-size:34px; font-weight:bold; letter-spacing:6px; color:#2D6AF6; margin:20px 0; text-align:center;">
              ${code}
            </div>
            <p style="font-size:14px; color:#444; margin:0;">ينتهي هذا الرمز خلال 5 دقائق.</p>
          </div>
        </div>
      `
    });

    return res.json({
      success: true,
      message: "تم إرسال كود تغيير كلمة السر"
    });
  } catch (error) {
    console.error("Forgot password error:", error);

    return res.json({
      success: false,
      message: "فشل إرسال كود تغيير كلمة السر"
    });
  }
});

// تغيير كلمة السر
app.post("/reset-password", (req, res) => {
  const email = normalizeEmail(req.body.email);
  const code = cleanText(req.body.code);
  const newPassword = cleanText(req.body.password);

  if (!email) {
    return res.json({
      success: false,
      message: "البريد الإلكتروني مطلوب"
    });
  }

  if (!code) {
    return res.json({
      success: false,
      message: "كود التحقق مطلوب"
    });
  }

  if (!newPassword) {
    return res.json({
      success: false,
      message: "كلمة المرور الجديدة مطلوبة"
    });
  }

  if (!isValidPassword(newPassword)) {
    return res.json({
      success: false,
      message: "كلمة المرور يجب أن تكون 8 أحرف أو أكثر"
    });
  }

  if (!users[email]) {
    return res.json({
      success: false,
      message: "الحساب غير موجود"
    });
  }

  const saved = otpStore[email];
  const check = isOtpValid(saved, code, "reset");

  if (!check.ok) {
    return res.json({
      success: false,
      message: check.message
    });
  }

  users[email].password = newPassword;

  delete otpStore[email];

  return res.json({
    success: true,
    message: "تم تغيير كلمة السر بنجاح"
  });
});

// اختبار سريع لعرض المستخدمين المحفوظين مؤقتاً
app.get("/users", (req, res) => {
  return res.json({
    success: true,
    users
  });
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
