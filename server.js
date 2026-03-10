const express = require("express");
const cors = require("cors");
const { Resend } = require("resend");

const app = express();

app.use(cors());
app.use(express.json());

const resend = new Resend(process.env.RESEND_API_KEY);

// تخزين مؤقت للأكواد
const otpStore = {};
const RATE_LIMIT_MS = 60 * 1000; 
const OTP_EXPIRES_MS = 5 * 60 * 1000; 
const MAX_VERIFY_ATTEMPTS = 3;

// تنظيف البريد
function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

// توليد كود
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// فحص البريد
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// الصفحة الرئيسية
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Sudan Crypto OTP API is running"
  });
});

// إرسال الكود
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
      from: "Sudan Crypto <noreply@sudancrypto.com>",
      to: email,
      subject: "رمز التحقق - سودان كربتو",
      html: `
        <div style="font-family: Arial; direction: rtl; text-align: right; background:#f7f9fc; padding:24px;">
          <div style="max-width:520px; margin:auto; background:#fff; border-radius:14px; padding:28px; border:1px solid #e6ecf5;">
            
            <h2 style="color:#2D6AF6;">سودان كربتو</h2>

            <p>تم طلب رمز تحقق لحسابك.</p>

            <p>رمز التحقق الخاص بك هو:</p>

            <div style="font-size:34px; font-weight:bold; letter-spacing:6px; color:#2D6AF6; text-align:center; margin:20px;">
              ${code}
            </div>

            <p>ينتهي هذا الرمز خلال 5 دقائق.</p>

            <p>إذا لم تطلب هذا الرمز يمكنك تجاهل الرسالة.</p>

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
app.post("/verify-code", (req, res) => {

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
        message: "تم تجاوز عدد المحاولات المسموح"
      });
    }

    if (saved.code !== code) {

      saved.attempts += 1;

      const attemptsLeft = MAX_VERIFY_ATTEMPTS - saved.attempts;

      return res.status(400).json({
        success: false,
        message: attemptsLeft > 0
          ? `الكود غير صحيح تبقت ${attemptsLeft} محاولة`
          : "الكود غير صحيح"
      });
    }

    saved.verified = true;

    return res.json({
      success: true,
      message: "تم التحقق بنجاح"
    });

  } catch (error) {

    console.error("Verify error:", error);

    return res.status(500).json({
      success: false,
      message: "فشل التحقق"
    });
  }

});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
