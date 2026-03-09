const express = require("express");
const cors = require("cors");
const { Resend } = require("resend");

const app = express();
app.use(cors());
app.use(express.json());

const resend = new Resend(process.env.RESEND_API_KEY);

// تخزين مؤقت للأكواد في الذاكرة
const otpStore = {};

// توليد كود 6 أرقام
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// إرسال كود التحقق
app.post("/send-code", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, message: "البريد الإلكتروني مطلوب" });
    }

    const code = generateOTP();

    otpStore[email] = {
      code,
      expiresAt: Date.now() + 5 * 60 * 1000, // 5 دقائق
    };

    await resend.emails.send({
      from: "onboarding@resend.dev",
      to: email,
      subject: "رمز التحقق - سودان كربتو",
      html: `
        <div style="font-family: Arial, sans-serif; direction: rtl; text-align: right;">
          <h2>سودان كربتو</h2>
          <p>رمز التحقق الخاص بك هو:</p>
          <div style="font-size: 32px; font-weight: bold; color: #2D6AF6; margin: 20px 0;">
            ${code}
          </div>
          <p>ينتهي هذا الرمز خلال 5 دقائق.</p>
          <p>إذا لم تطلب هذا الرمز، تجاهل هذه الرسالة.</p>
        </div>
      `,
    });

    return res.json({ success: true, message: "تم إرسال كود التحقق" });
  } catch (error) {
    console.error("Send code error:", error);
    return res.status(500).json({ success: false, message: "فشل إرسال الكود" });
  }
});

// التحقق من الكود
app.post("/verify-code", async (req, res) => {
  try {
    const { email, code } = req.body;

    const saved = otpStore[email];

    if (!saved) {
      return res.status(400).json({ success: false, message: "لم يتم العثور على كود لهذا البريد" });
    }

    if (Date.now() > saved.expiresAt) {
      delete otpStore[email];
      return res.status(400).json({ success: false, message: "انتهت صلاحية الكود" });
    }

    if (saved.code !== code) {
      return res.status(400).json({ success: false, message: "الكود غير صحيح" });
    }

    delete otpStore[email];

    return res.json({ success: true, message: "تم التحقق بنجاح" });
  } catch (error) {
    console.error("Verify code error:", error);
    return res.status(500).json({ success: false, message: "فشل التحقق من الكود" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
