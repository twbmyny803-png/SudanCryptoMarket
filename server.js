const express = require("express");
const cors = require("cors");
const { Resend } = require("resend");

const app = express();

app.use(cors());
app.use(express.json());

const resend = new Resend(process.env.RESEND_API_KEY);

// تخزين مؤقت للأكواد في الذاكرة
const otpStore = {};
const RATE_LIMIT_MS = 60 * 1000; // دقيقة بين كل إرسال
const OTP_EXPIRES_MS = 5 * 60 * 1000; // 5 دقائق
const MAX_VERIFY_ATTEMPTS = 3;

// تنظيف البريد
function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

// توليد كود 6 أرقام
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// فحص بسيط للبريد
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// الصفحة الرئيسية للسيرفر
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Sudan Crypto OTP API is running"
  });
});

// إرسال كود التحقق
app.post("/send-code", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "البريد الإلكتروني مطلوب"
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: "صيغة البريد الإلكتروني غير صحيحة"
      });
    }

    const now = Date.now();
    const existing = otpStore[email];

    if (existing && existing.lastSentAt && now - existing.lastSentAt < RATE_LIMIT_MS) {
      const secondsLeft = Math.ceil((RATE_LIMIT_MS - (now - existing.lastSentAt)) / 1000);

      return res.status(429).json({
        success: false,
        message: `انتظر ${secondsLeft} ثانية قبل طلب كود جديد`
      });
    }

    const code = generateOTP();

    otpStore[email] = {
      code,
      expiresAt: now + OTP_EXPIRES_MS,
      lastSentAt: now,
      attempts: 0,
      verified: false
    };

    await resend.emails.send({
      from: "Sudan Crypto <onboarding@resend.dev>",
      to: email,
      subject: "رمز التحقق - سودان كربتو",
      html: `
        <div style="font-family: Arial, sans-serif; direction: rtl; text-align: right; background:#f7f9fc; padding:24px;">
          <div style="max-width:520px; margin:0 auto; background:#ffffff; border-radius:14px; padding:28px; border:1px solid #e6ecf5;">
            <h2 style="margin:0 0 12px; color:#2D6AF6;">سودان كربتو</h2>
            <p style="font-size:16px; color:#1A1A1A; margin:0 0 14px;">
              تم طلب رمز تحقق لحسابك.
            </p>
            <p style="font-size:15px; color:#444; margin:0 0 14px;">
              رمز التحقق الخاص بك هو:
            </p>
            <div style="font-size:34px; font-weight:bold; letter-spacing:6px; color:#2D6AF6; margin:20px 0; text-align:center;">
              ${code}
            </div>
            <p style="font-size:14px; color:#444; margin:0 0 10px;">
              ينتهي هذا الرمز خلال 5 دقائق.
            </p>
            <p style="font-size:14px; color:#444; margin:0;">
              إذا لم تطلب هذا الرمز، تجاهل هذه الرسالة.
            </p>
          </div>
        </div>
      `
    });

    return res.json({
      success: true,
      message: "تم إرسال كود التحقق"
    });
  } catch (error) {
    console.error("Send code error:", error);

    return res.status(500).json({
      success: false,
      message: "فشل إرسال الكود"
    });
  }
});

// التحقق من الكود
app.post("/verify-code", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const code = String(req.body.code || "").trim();

    if (!email || !code) {
      return res.status(400).json({
        success: false,
        message: "البريد الإلكتروني والكود مطلوبان"
      });
    }

    const saved = otpStore[email];

    if (!saved) {
      return res.status(400).json({
        success: false,
        message: "لم يتم العثور على كود لهذا البريد"
      });
    }

    if (Date.now() > saved.expiresAt) {
      delete otpStore[email];

      return res.status(400).json({
        success: false,
        message: "انتهت صلاحية الكود"
      });
    }

    if (saved.attempts >= MAX_VERIFY_ATTEMPTS) {
      delete otpStore[email];

      return res.status(400).json({
        success: false,
        message: "تم تجاوز عدد المحاولات المسموح، اطلب كودًا جديدًا"
      });
    }

    if (saved.code !== code) {
      saved.attempts += 1;

      const attemptsLeft = MAX_VERIFY_ATTEMPTS - saved.attempts;

      return res.status(400).json({
        success: false,
        message: attemptsLeft > 0
          ? `الكود غير صحيح. تبقت ${attemptsLeft} محاولة`
          : "الكود غير صحيح"
      });
    }

    saved.verified = true;

    return res.json({
      success: true,
      message: "تم التحقق بنجاح"
    });
  } catch (error) {
    console.error("Verify code error:", error);

    return res.status(500).json({
      success: false,
      message: "فشل التحقق من الكود"
    });
  }
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
