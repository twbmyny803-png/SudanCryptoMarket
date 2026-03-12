const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Resend } = require("resend");

const app = express();

app.use(cors());
app.use(express.json());

const resend = new Resend(process.env.RESEND_API_KEY);

const otpStore = {};
const users = {};
const adminSessions = {};

const ADMIN_USERNAME = "admain";
const ADMIN_PASSWORD = "admin_2050";

const OTP_EXPIRES_MS = 5 * 60 * 1000;
const PASSWORD_MIN_LENGTH = 8;
const PACKAGE_DURATION_DAYS = 280;

function normalizeEmail(email){
  return String(email || "").trim().toLowerCase();
}

function cleanText(v){
  return String(v || "").trim();
}

function generateOTP(){
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function generateToken(){
  return crypto.randomBytes(24).toString("hex");
}

function isValidEmail(email){
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isOtpValid(saved, code, purpose){
  if(!saved){
    return { ok:false, message:"لم يتم طلب كود" };
  }

  if(saved.purpose !== purpose){
    return { ok:false, message:"نوع الكود غير صحيح" };
  }

  if(Date.now() > saved.expiresAt){
    return { ok:false, message:"انتهت صلاحية الكود" };
  }

  if(saved.code !== code){
    return { ok:false, message:"الكود غير صحيح" };
  }

  return { ok:true };
}

function generateReferralCode(name, email){
  const part1 = cleanText(name || email || "USR")
    .replace(/\s+/g, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .slice(0, 3) || "USR";

  const part2 = Math.floor(100 + Math.random() * 900).toString();

  return part1 + part2;
}

function getPackageInfo(pack){
  const p = cleanText(pack).toLowerCase();

  if(p === "starter"){
    return { key:"starter", name:"Starter", price:50, dailyProfit:2.5, durationDays:PACKAGE_DURATION_DAYS };
  }

  if(p === "silver"){
    return { key:"silver", name:"Silver", price:100, dailyProfit:5, durationDays:PACKAGE_DURATION_DAYS };
  }

  if(p === "gold"){
    return { key:"gold", name:"Gold", price:250, dailyProfit:8, durationDays:PACKAGE_DURATION_DAYS };
  }

  if(p === "diamond"){
    return { key:"diamond", name:"Diamond", price:500, dailyProfit:12, durationDays:PACKAGE_DURATION_DAYS };
  }

  if(p === "platinum"){
    return { key:"platinum", name:"Platinum", price:1000, dailyProfit:25, durationDays:PACKAGE_DURATION_DAYS };
  }

  return null;
}

function calculateProfit(user){
  if(!user.packageName || !user.packageStart){
    return 0;
  }

  const daysPassed = Math.floor((Date.now() - user.packageStart) / (1000 * 60 * 60 * 24));
  const payableDays = Math.min(Math.max(daysPassed, 0), user.packageDurationDays || 0);

  return payableDays * (user.dailyProfit || 0);
}

function isAdminAuthorized(req){
  const token =
    cleanText(req.headers["x-admin-token"]) ||
    cleanText(req.body.adminToken) ||
    cleanText(req.query.adminToken);

  if(token && adminSessions[token]){
    return true;
  }

  const username = cleanText(req.body.adminUsername || req.query.adminUsername);
  const password = cleanText(req.body.adminPassword || req.query.adminPassword);

  if(username === ADMIN_USERNAME && password === ADMIN_PASSWORD){
    return true;
  }

  return false;
}

function requireAdmin(req, res){
  if(!isAdminAuthorized(req)){
    res.json({ success:false, message:"غير مصرح لك" });
    return false;
  }
  return true;
}

function ensureUserCanUseAccount(user){
  if(!user){
    return { ok:false, message:"الحساب غير موجود" };
  }

  if(user.isDeleted){
    return { ok:false, message:"الحساب محذوف" };
  }

  if(user.isBanned){
    return { ok:false, message:"الحساب محظور" };
  }

  if(user.isFrozen){
    return { ok:false, message:"الحساب مجمد" };
  }

  return { ok:true };
}

function getOperationByIndex(user, index){
  const i = Number(index);

  if(Number.isNaN(i) || i < 0 || i >= user.operations.length){
    return null;
  }

  return user.operations[i];
}

app.get("/", (req, res) => {
  res.json({ success:true, message:"Sudan Crypto API running" });
});

/* تسجيل دخول الأدمن */
app.post("/admin-login", (req, res) => {
  const username = cleanText(req.body.username);
  const password = cleanText(req.body.password);

  if(username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD){
    return res.json({ success:false, message:"بيانات الأدمن غير صحيحة" });
  }

  const token = generateToken();
  adminSessions[token] = {
    username,
    createdAt: Date.now()
  };

  res.json({
    success:true,
    token
  });
});

/* إرسال كود */
app.post("/send-code", async (req, res) => {
  try{
    const email = normalizeEmail(req.body.email);
    const purpose = cleanText(req.body.purpose || "register");

    if(!email){
      return res.json({ success:false, message:"البريد مطلوب" });
    }

    if(!isValidEmail(email)){
      return res.json({ success:false, message:"بريد غير صحيح" });
    }

    if(purpose === "register" && users[email]){
      return res.json({ success:false, message:"البريد مسجل" });
    }

    const user = users[email];

    if((purpose === "login" || purpose === "reset") && !user){
      return res.json({ success:false, message:"الحساب غير موجود" });
    }

    if(user){
      const checkUser = ensureUserCanUseAccount(user);
      if(!checkUser.ok && purpose !== "register"){
        return res.json({ success:false, message:checkUser.message });
      }
    }

    const code = generateOTP();

    otpStore[email] = {
      code,
      purpose,
      expiresAt: Date.now() + OTP_EXPIRES_MS,
      verified: false
    };

    await resend.emails.send({
      from: "Sudan Crypto <noreply@sudancrypto.com>",
      to: email,
      subject: "رمز التحقق",
      html: `<h2>${code}</h2>`
    });

    res.json({ success:true });
  }catch(e){
    console.log(e);
    res.json({ success:false, message:"فشل ارسال الكود" });
  }
});

/* تحقق الكود */
app.post("/verify-code", (req, res) => {
  const email = normalizeEmail(req.body.email);
  const code = cleanText(req.body.code);
  const purpose = cleanText(req.body.purpose || "register");

  const saved = otpStore[email];
  const check = isOtpValid(saved, code, purpose);

  if(!check.ok){
    return res.json({ success:false, message:check.message });
  }

  otpStore[email].verified = true;

  res.json({ success:true });
});

/* تسجيل مستخدم */
app.post("/register", (req, res) => {
  const name = cleanText(req.body.name);
  const email = normalizeEmail(req.body.email);
  const phone = cleanText(req.body.phone);
  const referral = cleanText(req.body.referral);
  const password = cleanText(req.body.password);

  const saved = otpStore[email];

  if(!saved || saved.purpose !== "register" || saved.verified !== true){
    return res.json({ success:false, message:"يجب التحقق من البريد" });
  }

  if(!name){
    return res.json({ success:false, message:"الاسم مطلوب" });
  }

  if(!isValidEmail(email)){
    return res.json({ success:false, message:"البريد غير صحيح" });
  }

  if(!password || password.length < PASSWORD_MIN_LENGTH){
    return res.json({ success:false, message:"كلمة السر يجب أن تكون 8 أحرف أو أكثر" });
  }

  let referralCode = generateReferralCode(name, email);

  while(Object.values(users).some(u => u.referralCode === referralCode)){
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
    packageName: "",
    packagePrice: 0,
    dailyProfit: 0,
    packageStart: null,
    packageDurationDays: 0,
    isBanned: false,
    isFrozen: false,
    isDeleted: false,
    createdAt: new Date().toISOString()
  };

  delete otpStore[email];

  res.json({ success:true });
});

/* تسجيل دخول */
app.post("/login", (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = cleanText(req.body.password);
  const code = cleanText(req.body.code);

  const user = users[email];

  const canUse = ensureUserCanUseAccount(user);
  if(!canUse.ok){
    return res.json({ success:false, message:canUse.message });
  }

  if(user.password !== password){
    return res.json({ success:false, message:"كلمة السر خطأ" });
  }

  const saved = otpStore[email];
  const check = isOtpValid(saved, code, "login");

  if(!check.ok){
    return res.json({ success:false, message:check.message });
  }

  delete otpStore[email];

  res.json({ success:true, user });
});

/* بيانات المستخدم */
app.post("/user-data", (req, res) => {
  const email = normalizeEmail(req.body.email);
  const user = users[email];

  const canUse = ensureUserCanUseAccount(user);
  if(!canUse.ok){
    return res.json({ success:false, message:canUse.message });
  }

  const teamMembers = Object.values(users).filter(
    u => !u.isDeleted && u.referredBy === user.referralCode
  );

  const dailyIncome = calculateProfit(user);

  res.json({
    success:true,
    name:user.name,
    email:user.email,
    phone:user.phone,
    balance:user.balance,
    operations:user.operations,
    packageName:user.packageName,
    packagePrice:user.packagePrice,
    dailyProfitValue:user.dailyProfit,
    packageDurationDays:user.packageDurationDays,
    dailyIncome,
    referralCode:user.referralCode,
    referralCount:teamMembers.length,
    isBanned:user.isBanned,
    isFrozen:user.isFrozen
  });
});

/* طلب إيداع */
app.post("/deposit", (req, res) => {
  const email = normalizeEmail(req.body.email);
  const amount = Number(req.body.amount);
  const network = cleanText(req.body.network);
  const txid = cleanText(req.body.txid);
  const packageName = cleanText(req.body.packageName);
  const dailyProfit = Number(req.body.dailyProfit || 0);
  const durationDays = Number(req.body.durationDays || 0);

  const user = users[email];

  const canUse = ensureUserCanUseAccount(user);
  if(!canUse.ok){
    return res.json({ success:false, message:canUse.message });
  }

  if(!amount || amount <= 0){
    return res.json({ success:false, message:"المبلغ غير صحيح" });
  }

  if(!network){
    return res.json({ success:false, message:"اختر الشبكة" });
  }

  if(!txid){
    return res.json({ success:false, message:"أدخل رقم العملية TXID" });
  }

  user.operations.unshift({
    type: packageName ? "package_deposit" : "deposit",
    packageName,
    amount,
    network,
    txid,
    dailyProfit,
    durationDays,
    status:"pending",
    date:new Date().toISOString()
  });

  res.json({ success:true });
});

/* طلب سحب */
app.post("/withdraw", (req, res) => {
  const email = normalizeEmail(req.body.email);
  const amount = Number(req.body.amount);
  const user = users[email];

  const canUse = ensureUserCanUseAccount(user);
  if(!canUse.ok){
    return res.json({ success:false, message:canUse.message });
  }

  if(!amount || amount <= 0){
    return res.json({ success:false, message:"أدخل مبلغ صحيح" });
  }

  if(user.balance < amount){
    return res.json({ success:false, message:"الرصيد غير كافي" });
  }

  user.operations.unshift({
    type:"withdraw",
    amount,
    status:"pending",
    date:new Date().toISOString()
  });

  res.json({ success:true });
});

/* موافقة الأدمن */
app.post("/approve-operation", (req, res) => {
  if(!requireAdmin(req, res)) return;

  const email = normalizeEmail(req.body.email);
  const index = req.body.index;

  const user = users[email];
  if(!user || user.isDeleted){
    return res.json({ success:false, message:"الحساب غير موجود" });
  }

  const op = getOperationByIndex(user, index);
  if(!op){
    return res.json({ success:false, message:"العملية غير موجودة" });
  }

  if(op.status !== "pending"){
    return res.json({ success:false, message:"تمت معالجة العملية مسبقاً" });
  }

  if(op.type === "deposit"){
    user.balance += Number(op.amount || 0);
    op.status = "approved";
    return res.json({ success:true });
  }

  if(op.type === "package_deposit"){
    user.packageName = op.packageName;
    user.packagePrice = Number(op.amount || 0);
    user.dailyProfit = Number(op.dailyProfit || 0);
    user.packageStart = Date.now();
    user.packageDurationDays = Number(op.durationDays || 0);
    op.status = "approved";
    return res.json({ success:true });
  }

  if(op.type === "withdraw"){
    const amount = Number(op.amount || 0);

    if(user.balance < amount){
      return res.json({ success:false, message:"رصيد المستخدم غير كافٍ حالياً" });
    }

    user.balance -= amount;
    op.status = "approved";
    return res.json({ success:true });
  }

  res.json({ success:false, message:"نوع العملية غير مدعوم" });
});

/* رفض العملية */
app.post("/reject-operation", (req, res) => {
  if(!requireAdmin(req, res)) return;

  const email = normalizeEmail(req.body.email);
  const index = req.body.index;

  const user = users[email];
  if(!user || user.isDeleted){
    return res.json({ success:false, message:"الحساب غير موجود" });
  }

  const op = getOperationByIndex(user, index);
  if(!op){
    return res.json({ success:false, message:"العملية غير موجودة" });
  }

  if(op.status !== "pending"){
    return res.json({ success:false, message:"تمت معالجة العملية مسبقاً" });
  }

  op.status = "rejected";
  res.json({ success:true });
});

/* قائمة المستخدمين للأدمن */
app.get("/users", (req, res) => {
  res.json({ success:true, users });
});

/* قائمة المستخدمين المؤمنة للأدمن */
app.get("/admin-users", (req, res) => {
  if(!requireAdmin(req, res)) return;

  const safeUsers = Object.values(users)
    .filter(user => !user.isDeleted)
    .map(user => ({
      id:user.id,
      name:user.name,
      email:user.email,
      phone:user.phone,
      balance:user.balance,
      packageName:user.packageName,
      dailyProfit:user.dailyProfit,
      referralCode:user.referralCode,
      isBanned:user.isBanned,
      isFrozen:user.isFrozen,
      createdAt:user.createdAt
    }));

  res.json({ success:true, users:safeUsers });
});

/* إضافة رصيد */
app.post("/admin-add-balance", (req, res) => {
  if(!requireAdmin(req, res)) return;

  const email = normalizeEmail(req.body.email);
  const amount = Number(req.body.amount);

  const user = users[email];
  if(!user || user.isDeleted){
    return res.json({ success:false, message:"الحساب غير موجود" });
  }

  if(!amount || amount <= 0){
    return res.json({ success:false, message:"المبلغ غير صحيح" });
  }

  user.balance += amount;

  user.operations.unshift({
    type:"admin_add_balance",
    amount,
    status:"approved",
    date:new Date().toISOString()
  });

  res.json({ success:true });
});

/* خصم رصيد */
app.post("/admin-remove-balance", (req, res) => {
  if(!requireAdmin(req, res)) return;

  const email = normalizeEmail(req.body.email);
  const amount = Number(req.body.amount);

  const user = users[email];
  if(!user || user.isDeleted){
    return res.json({ success:false, message:"الحساب غير موجود" });
  }

  if(!amount || amount <= 0){
    return res.json({ success:false, message:"المبلغ غير صحيح" });
  }

  if(user.balance < amount){
    return res.json({ success:false, message:"رصيد المستخدم غير كافٍ" });
  }

  user.balance -= amount;

  user.operations.unshift({
    type:"admin_remove_balance",
    amount,
    status:"approved",
    date:new Date().toISOString()
  });

  res.json({ success:true });
});

/* تغيير كلمة السر */
app.post("/admin-change-password", (req, res) => {
  if(!requireAdmin(req, res)) return;

  const email = normalizeEmail(req.body.email);
  const newPassword = cleanText(req.body.newPassword);

  const user = users[email];
  if(!user || user.isDeleted){
    return res.json({ success:false, message:"الحساب غير موجود" });
  }

  if(!newPassword || newPassword.length < PASSWORD_MIN_LENGTH){
    return res.json({ success:false, message:"كلمة السر قصيرة" });
  }

  user.password = newPassword;

  res.json({ success:true });
});

/* حظر حساب */
app.post("/admin-ban-user", (req, res) => {
  if(!requireAdmin(req, res)) return;

  const email = normalizeEmail(req.body.email);
  const user = users[email];

  if(!user || user.isDeleted){
    return res.json({ success:false, message:"الحساب غير موجود" });
  }

  user.isBanned = true;

  res.json({ success:true });
});

/* فك حظر */
app.post("/admin-unban-user", (req, res) => {
  if(!requireAdmin(req, res)) return;

  const email = normalizeEmail(req.body.email);
  const user = users[email];

  if(!user || user.isDeleted){
    return res.json({ success:false, message:"الحساب غير موجود" });
  }

  user.isBanned = false;

  res.json({ success:true });
});

/* تجميد حساب */
app.post("/admin-freeze-user", (req, res) => {
  if(!requireAdmin(req, res)) return;

  const email = normalizeEmail(req.body.email);
  const user = users[email];

  if(!user || user.isDeleted){
    return res.json({ success:false, message:"الحساب غير موجود" });
  }

  user.isFrozen = true;

  res.json({ success:true });
});

/* فك تجميد */
app.post("/admin-unfreeze-user", (req, res) => {
  if(!requireAdmin(req, res)) return;

  const email = normalizeEmail(req.body.email);
  const user = users[email];

  if(!user || user.isDeleted){
    return res.json({ success:false, message:"الحساب غير موجود" });
  }

  user.isFrozen = false;

  res.json({ success:true });
});

/* حذف حساب */
app.post("/admin-delete-user", (req, res) => {
  if(!requireAdmin(req, res)) return;

  const email = normalizeEmail(req.body.email);
  const user = users[email];

  if(!user){
    return res.json({ success:false, message:"الحساب غير موجود" });
  }

  user.isDeleted = true;

  res.json({ success:true });
});

/* تفعيل باقة من الأدمن */
app.post("/admin-set-package", (req, res) => {
  if(!requireAdmin(req, res)) return;

  const email = normalizeEmail(req.body.email);
  const packageKey = cleanText(req.body.package);

  const user = users[email];
  if(!user || user.isDeleted){
    return res.json({ success:false, message:"الحساب غير موجود" });
  }

  const info = getPackageInfo(packageKey);
  if(!info){
    return res.json({ success:false, message:"الباقة غير صحيحة" });
  }

  user.packageName = info.name;
  user.packagePrice = info.price;
  user.dailyProfit = info.dailyProfit;
  user.packageStart = Date.now();
  user.packageDurationDays = info.durationDays;

  user.operations.unshift({
    type:"admin_set_package",
    packageName:info.name,
    amount:info.price,
    dailyProfit:info.dailyProfit,
    durationDays:info.durationDays,
    status:"approved",
    date:new Date().toISOString()
  });

  res.json({ success:true });
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
