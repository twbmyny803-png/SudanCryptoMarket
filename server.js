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
const MAX_VERIFY_ATTEMPTS = 3;

// تنظيف البريد
function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

// توليد كود
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// فحص الإيميل
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// الصفحة الرئيسية
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Sudan Crypto API running"
  });
});


// ارسال كود التحقق
app.post("/send-code", async (req, res) => {

  try {

    const email = normalizeEmail(req.body.email);

    if (!email) {
      return res.json({
        success:false,
        message:"البريد مطلوب"
      });
    }

    if (!isValidEmail(email)) {
      return res.json({
        success:false,
        message:"صيغة البريد غير صحيحة"
      });
    }

    const code = generateOTP();

    otpStore[email] = {
      code,
      expiresAt: Date.now() + OTP_EXPIRES_MS,
      attempts:0
    };

    await resend.emails.send({
      from: "Sudan Crypto <noreply@sudancrypto.com>",
      to: email,
      subject: "رمز التحقق",
      html: `
      <h2>سودان كربتو</h2>
      <p>رمز التحقق الخاص بك:</p>
      <h1>${code}</h1>
      <p>ينتهي خلال 5 دقائق</p>
      `
    });

    res.json({
      success:true,
      message:"تم إرسال الكود"
    });

  } catch (error) {

    console.log(error);

    res.json({
      success:false,
      message:"فشل إرسال الكود"
    });

  }

});


// التحقق من الكود
app.post("/verify-code", (req,res)=>{

  const email = normalizeEmail(req.body.email);
  const code = req.body.code;

  const saved = otpStore[email];

  if(!saved){
    return res.json({
      success:false,
      message:"لا يوجد كود"
    });
  }

  if(Date.now() > saved.expiresAt){
    return res.json({
      success:false,
      message:"انتهت صلاحية الكود"
    });
  }

  if(saved.code !== code){
    return res.json({
      success:false,
      message:"الكود غير صحيح"
    });
  }

  res.json({
    success:true,
    message:"تم التحقق"
  });

});



// تسجيل حساب
app.post("/register",(req,res)=>{

  const email = normalizeEmail(req.body.email);
  const password = req.body.password;

  if(!email || !password){
    return res.json({
      success:false,
      message:"البريد وكلمة السر مطلوبان"
    });
  }

  if(users[email]){
    return res.json({
      success:false,
      message:"الحساب موجود مسبقاً"
    });
  }

  users[email] = {
    email,
    password
  };

  res.json({
    success:true,
    message:"تم إنشاء الحساب"
  });

});



// تسجيل الدخول
app.post("/login",(req,res)=>{

  const email = normalizeEmail(req.body.email);
  const password = req.body.password;

  const user = users[email];

  if(!user){
    return res.json({
      success:false,
      message:"الحساب غير موجود"
    });
  }

  if(user.password !== password){
    return res.json({
      success:false,
      message:"كلمة السر غير صحيحة"
    });
  }

  res.json({
    success:true,
    message:"تم تسجيل الدخول"
  });

});



// طلب تغيير كلمة السر
app.post("/forgot-password", async (req,res)=>{

const email = normalizeEmail(req.body.email);

if(!users[email]){
return res.json({
success:false,
message:"الحساب غير موجود"
});
}

const code = generateOTP();

otpStore[email] = {
code,
expiresAt: Date.now() + OTP_EXPIRES_MS
};

await resend.emails.send({

from:"Sudan Crypto <noreply@sudancrypto.com>",
to:email,
subject:"إعادة تعيين كلمة السر",
html:`
<h2>تغيير كلمة السر</h2>
<p>رمز التغيير:</p>
<h1>${code}</h1>
`

});

res.json({
success:true,
message:"تم إرسال كود تغيير كلمة السر"
});

});



// تغيير كلمة السر
app.post("/reset-password",(req,res)=>{

const email = normalizeEmail(req.body.email);
const code = req.body.code;
const newPassword = req.body.password;

const saved = otpStore[email];

if(!saved){
return res.json({
success:false,
message:"لم يتم طلب كود"
});
}

if(saved.code !== code){
return res.json({
success:false,
message:"الكود غير صحيح"
});
}

users[email].password = newPassword;

delete otpStore[email];

res.json({
success:true,
message:"تم تغيير كلمة السر"
});

});



const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
