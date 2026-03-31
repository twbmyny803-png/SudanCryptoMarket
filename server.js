const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Resend } = require("resend");
const { MongoClient } = require("mongodb");
const multer = require("multer");
const path = require("path");
const cron = require("node-cron");
const fetch = require("node-fetch");

const app = express();

app.use(cors());
app.use(express.json());

const resend = new Resend(process.env.RESEND_API_KEY);

const client = new MongoClient(process.env.MONGODB_URI);

let db;
let usersCollection;
let otpCollection;
let verifyCollection;

const adminSessions = {};
let payments = [];

const ADMIN_USERNAME = "admain";
const ADMIN_PASSWORD = "admin_2050";

const OTP_EXPIRES_MS = 5 * 60 * 1000;
const PACKAGE_DURATION_DAYS = 280;

/* ---------------- UPLOAD SETUP ---------------- */

const storage = multer.diskStorage({
  destination: function(req,file,cb){
    cb(null,"uploads/");
  },
  filename: function(req,file,cb){
    const unique = Date.now() + "-" + Math.round(Math.random()*1E9);
    cb(null, unique + path.extname(file.originalname));
  }
});

const upload = multer({ storage });
app.use("/uploads",express.static("uploads"));

/* ---------------- FUNCTIONS ---------------- */

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

function generateRefCode(){
  return Math.random().toString(36).substring(2,8).toUpperCase();
}

function isValidEmail(email){
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function requireAdmin(req,res){
  const token = req.headers["x-admin-token"];

  if(!token || !adminSessions[token]){
    res.json({success:false,message:"غير مصرح"});
    return false;
  }

  return true;
}

function getPackageInfo(pack){
  const p = cleanText(pack).toLowerCase();

  if(p === "starter"){
    return {name:"Starter",price:50,dailyProfit:2.5,durationDays:PACKAGE_DURATION_DAYS};
  }

  if(p === "silver"){
    return {name:"Silver",price:100,dailyProfit:5,durationDays:PACKAGE_DURATION_DAYS};
  }

  if(p === "gold"){
    return {name:"Gold",price:250,dailyProfit:8,durationDays:PACKAGE_DURATION_DAYS};
  }

  if(p === "diamond"){
    return {name:"Diamond",price:500,dailyProfit:12,durationDays:PACKAGE_DURATION_DAYS};
  }

  if(p === "platinum"){
    return {name:"Platinum",price:1000,dailyProfit:25,durationDays:PACKAGE_DURATION_DAYS};
  }

  return null;
}

// دالة إلغاء الطلبات منتهية الوقت
async function cancelExpiredDepositsNow() {
  try {
    const users = await usersCollection.find({}).toArray();
    let anyChanged = false;

    for (const user of users) {
      const operations = user.operations || [];
      let changed = false;

      for (let i = 0; i < operations.length; i++) {
        const op = operations[i];

        if (
          (op.type === "package_deposit" || op.type === "deposit") &&
          op.status === "pending" &&
          op.expiresAt &&
          Date.now() > op.expiresAt
        ) {
          operations[i].status = "cancelled";
          changed = true;
          anyChanged = true;
        }
      }

      if (changed) {
        await usersCollection.updateOne(
          { email: user.email },
          { $set: { operations } }
        );
      }
    }

    if (anyChanged) {
      console.log("✅ تم إلغاء الطلبات منتهية الوقت:", new Date().toISOString());
    }
  } catch (e) {
    console.log("خطأ في إلغاء الطلبات:", e);
  }
}

function calculateDailyAccruedProfit(user){
  if(!user.packageName || !user.packageStart || !user.dailyProfit){
    return 0;
  }

  const start = new Date(user.packageStart).getTime();
  if(!start){
    return 0;
  }

  const daysPassed = Math.floor((Date.now() - start) / (1000 * 60 * 60 * 24));
  const payableDays = Math.min(Math.max(daysPassed, 0), Number(user.packageDurationDays || 0));

  return payableDays * Number(user.dailyProfit || 0);
}

async function applyPendingDailyProfit(user){

  if(!user.packageName || !user.lastProfitAt){
    return user;
  }

  const now = Date.now();
  const last = new Date(user.lastProfitAt).getTime();

  const hoursPassed = (now - last) / (1000 * 60 * 60);

  if(hoursPassed < 24){
    return user;
  }

  let daysToAdd = Math.floor(hoursPassed / 24);
  const totalDays = Number(user.profitDays || 0);
  const maxDays = Number(user.packageDurationDays || 280);

  const remainingDays = maxDays - totalDays;

  if(remainingDays <= 0){
    return user;
  }

  let actualDays = Math.min(daysToAdd, remainingDays);

  if (totalDays === 0 && actualDays > 0) {
    actualDays = 1;
  }

  const totalProfit = actualDays * Number(user.dailyProfit || 0);

  await usersCollection.updateOne(
    { email:user.email },
    {
      $inc:{
        incomeBalance: totalProfit,
        profitDays: actualDays
      },
      $set:{
        lastProfitAt: new Date().toISOString()
      },
      $push:{
        operations:{
          $each:[{
            type:"daily_profit",
            amount: totalProfit,
            days: actualDays,
            status:"approved",
            date:new Date().toISOString()
          }],
          $position:0
        }
      }
    }
  );

  return await usersCollection.findOne({ email:user.email });
}

async function runDailyProfitForAllUsers(){
  try{
    const users = await usersCollection.find({
      isDeleted: { $ne:true },
      isBanned: { $ne:true },
      isFrozen: { $ne:true },
      packageName: { $ne:"" },
      packageStart: { $ne:null },
      dailyProfit: { $gt:0 }
    }).toArray();

    for(const user of users){
      await applyPendingDailyProfit(user);
    }

    console.log("Daily profit job finished:", new Date().toISOString());

  }catch(e){
    console.log("Daily profit job error:", e);
  }
}

/* ---------------- REFERRAL FUNCTIONS WITH LEVELS ---------------- */

function getCommissionByPackageAndLevel(packageAmount, level) {
  const commissionTable = {
    50: { level1: 5, level2: 2, level3: 1 },
    100: { level1: 7, level2: 3, level3: 2 },
    250: { level1: 10, level2: 5, level3: 3 },
    500: { level1: 12, level2: 7, level3: 4 },
    1000: { level1: 15, level2: 10, level3: 5 }
  };
  
  const pkg = commissionTable[packageAmount];
  if (!pkg) return 0;
  
  if (level === 1) return pkg.level1;
  if (level === 2) return pkg.level2;
  if (level === 3) return pkg.level3;
  return 0;
}

async function distributeReferralCommission(user, price) {
  if (!user.referrer) return;
  
  const level1User = await usersCollection.findOne({ refCode: user.referrer });
  if (level1User) {
    const commission = getCommissionByPackageAndLevel(price, 1);
    if (commission > 0) {
      await usersCollection.updateOne(
        { email: level1User.email },
        {
          $inc: { incomeBalance: commission },
          $push: {
            operations: {
              $each: [{
                type: "referral_bonus",
                amount: commission,
                level: 1,
                from: user.email,
                packageAmount: price,
                status: "approved",
                date: new Date().toISOString()
              }],
              $position: 0
            }
          }
        }
      );
    }
    
    if (level1User.referrer) {
      const level2User = await usersCollection.findOne({ refCode: level1User.referrer });
      if (level2User) {
        const commission2 = getCommissionByPackageAndLevel(price, 2);
        if (commission2 > 0) {
          await usersCollection.updateOne(
            { email: level2User.email },
            {
              $inc: { incomeBalance: commission2 },
              $push: {
                operations: {
                  $each: [{
                    type: "referral_bonus",
                    amount: commission2,
                    level: 2,
                    from: user.email,
                    packageAmount: price,
                    status: "approved",
                    date: new Date().toISOString()
                  }],
                  $position: 0
                }
              }
            }
          );
        }
        
        if (level2User.referrer) {
          const level3User = await usersCollection.findOne({ refCode: level2User.referrer });
          if (level3User) {
            const commission3 = getCommissionByPackageAndLevel(price, 3);
            if (commission3 > 0) {
              await usersCollection.updateOne(
                { email: level3User.email },
                {
                  $inc: { incomeBalance: commission3 },
                  $push: {
                    operations: {
                      $each: [{
                        type: "referral_bonus",
                        amount: commission3,
                        level: 3,
                        from: user.email,
                        packageAmount: price,
                        status: "approved",
                        date: new Date().toISOString()
                      }],
                      $position: 0
                    }
                  }
                }
              );
            }
          }
        }
      }
    }
  }
}

/* ---------------- ROOT ---------------- */

app.get("/",(req,res)=>{
  res.json({success:true,message:"Sudan Crypto API running"});
});

/* ---------------- ADMIN LOGIN ---------------- */

app.post("/admin-login",(req,res)=>{
  const username = cleanText(req.body.username);
  const password = cleanText(req.body.password);

  if(username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD){
    return res.json({success:false,message:"بيانات الأدمن غير صحيحة"});
  }

  const token = generateToken();
  adminSessions[token] = { createdAt:Date.now() };

  res.json({success:true,token});
});

/* ---------------- SEND OTP ---------------- */

app.post("/send-code", async (req,res)=>{
  try{
    const email = normalizeEmail(req.body.email);

    if(!email){
      return res.json({success:false,message:"البريد مطلوب"});
    }

    if(!isValidEmail(email)){
      return res.json({success:false,message:"بريد غير صحيح"});
    }

    const existingUser = await usersCollection.findOne({ email });

    if(existingUser){
      return res.json({success:false,message:"البريد مسجل"});
    }

    const code = generateOTP();

    await otpCollection.updateOne(
      { email },
      {
        $set:{
          email,
          code,
          expiresAt: Date.now() + OTP_EXPIRES_MS,
          verified:false
        }
      },
      { upsert:true }
    );

    await resend.emails.send({
      from:"Sudan Crypto <noreply@sudancrypto.com>",
      to:email,
      subject:"رمز التحقق",
      html:`<h2>${code}</h2>`
    });

    res.json({success:true});

  }catch(e){
    console.log(e);
    res.json({success:false,message:"فشل ارسال الكود"});
  }
});

/* ---------------- SEND WITHDRAW CODE ---------------- */

app.post("/send-withdraw-code", async (req,res)=>{
  try{

    const email = normalizeEmail(req.body.email)

    if(!email){
      return res.json({success:false,message:"البريد مطلوب"})
    }

    const user = await usersCollection.findOne({ email })

    if(!user){
      return res.json({success:false,message:"الحساب غير موجود"})
    }

    const code = generateOTP()

    await otpCollection.updateOne(
      { email },
      {
        $set:{
          email,
          code,
          expiresAt: Date.now() + OTP_EXPIRES_MS
        }
      },
      { upsert:true }
    )

    await resend.emails.send({
      from:"Sudan Crypto <noreply@sudancrypto.com>",
      to:email,
      subject:"رمز سحب الأموال",
      html:`<h2>${code}</h2>`
    })

    res.json({success:true})

  }catch(e){
    console.log(e)
    res.json({success:false,message:"فشل إرسال الكود"})
  }
})

/* ---------------- VERIFY OTP ---------------- */

app.post("/verify-code", async (req,res)=>{
  try{
    const email = normalizeEmail(req.body.email);
    const code = cleanText(req.body.code);

    const saved = await otpCollection.findOne({ email });

    if(!saved){
      return res.json({success:false,message:"لم يتم طلب كود"});
    }

    if(saved.code !== code){
      return res.json({success:false,message:"الكود غير صحيح"});
    }

    if(Date.now() > Number(saved.expiresAt || 0)){
      return res.json({success:false,message:"انتهت صلاحية الكود"});
    }

    await otpCollection.updateOne(
      { email },
      { $set:{ verified:true } }
    );

    res.json({success:true});

  }catch(e){
    console.log(e);
    res.json({success:false,message:"فشل التحقق"});
  }
});

/* ---------------- REGISTER ---------------- */

app.post("/register", async (req,res)=>{
  try{
    const name = cleanText(req.body.name);
    const email = normalizeEmail(req.body.email);
    const phone = cleanText(req.body.phone);
    const password = cleanText(req.body.password);

    const existingUser = await usersCollection.findOne({ email });

    if(existingUser){
      return res.json({success:false,message:"البريد مسجل"});
    }

    await usersCollection.insertOne({
      name,
      email,
      phone,
      password,
      withdrawPassword: "",

      refCode: generateRefCode(),
      referrer: req.body.referrer || null,
      referrals:[],

      balance:0,
      incomeBalance:0,
      operations:[],
      packageName:"",
      packagePrice:0,
      dailyProfit:0,
      packageStart:null,
      packageDurationDays:0,
      profitDays:0,
      lastProfitAt: null,
      isBanned:false,
      isFrozen:false,
      isDeleted:false,
      createdAt:new Date().toISOString()
    });

    if(req.body.referrer){
      await usersCollection.updateOne(
        { refCode:req.body.referrer },
        {
          $push:{ referrals:email }
        }
      )
    }

    await otpCollection.deleteOne({ email });

    res.json({success:true});

  }catch(e){
    console.log(e);
    res.json({success:false,message:"فشل إنشاء الحساب"});
  }
});

/* ---------------- SET WITHDRAW PASSWORD ---------------- */

app.post("/set-withdraw-password", async (req,res)=>{
  try{

    const email = normalizeEmail(req.body.email);
    const pass = cleanText(req.body.password);

    if(pass.length !== 6){
      return res.json({success:false,message:"كلمة السحب يجب تكون 6 أرقام"});
    }

    await usersCollection.updateOne(
      { email },
      { $set:{ withdrawPassword: pass } }
    );

    res.json({success:true});

  }catch(e){
    console.log(e);
    res.json({success:false,message:"فشل حفظ كلمة السحب"});
  }
});

/* ---------------- LOGIN ---------------- */

app.post("/login", async (req,res)=>{
  try{
    const email = normalizeEmail(req.body.email);
    const password = cleanText(req.body.password);

    let user = await usersCollection.findOne({ email });

    if(!user){
      return res.json({success:false,message:"الحساب غير موجود"});
    }

    if(user.isDeleted){
      return res.json({success:false,message:"الحساب محذوف"});
    }

    if(user.isBanned){
      return res.json({success:false,message:"الحساب محظور"});
    }

    if(user.isFrozen){
      return res.json({success:false,message:"الحساب مجمد"});
    }

    if(user.password !== password){
      return res.json({success:false,message:"كلمة السر خطأ"});
    }

    user = await applyPendingDailyProfit(user);

    res.json({
      success:true,
      user:{
        name:user.name,
        email:user.email,
        phone:user.phone,
        refCode:user.refCode,
        balance:user.balance,
        incomeBalance:user.incomeBalance,
        packageName:user.packageName,
        packagePrice:user.packagePrice,
        dailyProfit:user.dailyProfit,
        packageStart:user.packageStart,
        packageDurationDays:user.packageDurationDays
      }
    });

  }catch(e){
    console.log(e);
    res.json({success:false,message:"فشل تسجيل الدخول"});
  }
});

/* ---------------- USER DATA ---------------- */

app.post("/user-data", async (req,res)=>{
  try{
    const email = normalizeEmail(req.body.email);

    let user = await usersCollection.findOne({ email });

    if(!user || user.isDeleted){
      return res.json({success:false});
    }

    user = await applyPendingDailyProfit(user);

    res.json({
      success:true,
      name:user.name,
      email:user.email,
      phone:user.phone || "",

      balance:user.balance || 0,
      incomeBalance:user.incomeBalance || 0,

      refCode:user.refCode,
      referrals:user.referrals || [],

      operations:user.operations || [],
      packageName:user.packageName || "",
      packagePrice:user.packagePrice || 0,
      dailyProfit:user.dailyProfit || 0,
      packageStart:user.packageStart || null,
      packageDurationDays:user.packageDurationDays || 0,
      profitDays: user.profitDays || 0,
      lastProfitAt: user.lastProfitAt || null,
      accruedProfit: calculateDailyAccruedProfit(user)
    });

  }catch(e){
    console.log(e);
    res.json({success:false,message:"فشل تحميل البيانات"});
  }
});

/* ---------------- MY TEAM WITH LEVELS ---------------- */

app.post("/my-team", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    
    const user = await usersCollection.findOne({ email });
    if (!user || user.isDeleted) {
      return res.json({ success: false, message: "المستخدم غير موجود" });
    }
    
    const allUsers = await usersCollection.find({ isDeleted: { $ne: true } }).toArray();
    
    function getUserLevel(targetEmail, referrerCode, currentLevel = 1) {
      if (!referrerCode || currentLevel > 3) return null;
      
      const referrerUser = allUsers.find(u => u.refCode === referrerCode);
      if (!referrerUser) return null;
      
      if (referrerUser.email === targetEmail) {
        return currentLevel;
      }
      
      if (referrerUser.referrer) {
        return getUserLevel(targetEmail, referrerUser.referrer, currentLevel + 1);
      }
      
      return null;
    }
    
    const teamWithLevels = [];
    
    for (const u of allUsers) {
      if (u.email === email) continue;
      
      const level = getUserLevel(email, u.referrer, 1);
      if (level && level <= 3) {
        teamWithLevels.push({
          name: u.name,
          email: u.email,
          phone: u.phone || "",
          package: u.packagePrice || 0,
          level: level,
          registeredAt: u.createdAt
        });
      }
    }
    
    const level1Count = teamWithLevels.filter(m => m.level === 1).length;
    const level2Count = teamWithLevels.filter(m => m.level === 2).length;
    const level3Count = teamWithLevels.filter(m => m.level === 3).length;
    
    res.json({
      success: true,
      team: teamWithLevels,
      count: teamWithLevels.length,
      level1Count: level1Count,
      level2Count: level2Count,
      level3Count: level3Count
    });
    
  } catch(e) {
    console.log(e);
    res.json({ success: false, message: "فشل تحميل الفريق" });
  }
});

/* ---------------- WITHDRAW ---------------- */

app.post("/withdraw", async (req,res)=>{
  try{
    const email = normalizeEmail(req.body.email);
    const amount = Number(req.body.amount);
    const network = cleanText(req.body.network);
    const withdrawPass = cleanText(req.body.withdrawPassword);

    let user = await usersCollection.findOne({ email });

    if(!user || user.isDeleted){
      return res.json({success:false});
    }

    if(!user.withdrawPassword){
      return res.json({success:false,message:"قم بتعيين كلمة السحب أولاً"});
    }

    if(user.withdrawPassword !== withdrawPass){
      return res.json({success:false,message:"كلمة السحب غير صحيحة"});
    }

    user = await applyPendingDailyProfit(user);

    if(Number(user.balance || 0) < amount){
      return res.json({success:false,message:"الرصيد غير كافي"});
    }

    await usersCollection.updateOne(
      { email },
      {
        $push:{
          operations:{
            $each:[{
              type:"withdraw",
              amount,
              network,
              status:"pending",
              date:new Date().toISOString()
            }],
            $position:0
          }
        }
      }
    );

    res.json({success:true});

  }catch(e){
    console.log(e);
    res.json({success:false,message:"فشل السحب"});
  }
});

/* ---------------- ADMIN USERS ---------------- */

app.get("/admin-users", async (req,res)=>{
  try{
    if(!requireAdmin(req,res)) return;

    const list = await usersCollection.find({ isDeleted:{ $ne:true } }).toArray();

    res.json({success:true,users:list});

  }catch(e){
    console.log(e);
    res.json({success:false,message:"فشل تحميل قائمة المستخدمين"});
  }
});

/* ---------------- ADMIN DEPOSITS ---------------- */

app.get("/admin-deposits", async (req,res)=>{
  try{
    if(!requireAdmin(req,res)) return;

    const users = await usersCollection.find({}).toArray();

    const deposits = [];

    users.forEach(user => {
      if (!user.operations) return;
      
      user.operations.forEach((op, index) => {
        if (op.type === "deposit" || op.type === "package_deposit") {
          deposits.push({
            id: user.email + "_" + index,
            orderId: op.orderId,
            email: user.email,
            name: user.name || "غير معروف",
            amount: op.amount,
            currency: "USDT",
            network: op.network || "",
            txid: op.txid || "",
            packageName: op.packageName || "",
            status: op.status,
            proof: op.proof || "",
            index: index,
            date: op.date || ""
          });
        }
      });
    });

    deposits.sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json({ success: true, deposits });
  } catch(e){
    console.log(e);
    res.json({ success: false, message: "فشل تحميل طلبات الإيداع" });
  }
});

/* ---------------- ADMIN WITHDRAWS ---------------- */

app.get("/admin-withdraws", async (req,res)=>{
  try{
    if(!requireAdmin(req,res)) return;

    const users = await usersCollection.find({ isDeleted:{ $ne:true } }).toArray();

    const withdraws = [];

    users.forEach(user=>{
      (user.operations || []).forEach((op,index)=>{
        if(op.type === "withdraw"){
          withdraws.push({
            id:user.email + "_" + index,
            email:user.email,
            name:user.name,
            amount:op.amount,
            currency:"USDT",
            network:op.network || "",
            status:op.status,
            index
          });
        }
      });
    });

    res.json({success:true,withdraws});

  }catch(e){
    console.log(e);
    res.json({success:false,message:"فشل تحميل طلبات السحب"});
  }
});

/* ---------------- ADMIN OPERATIONS ---------------- */

// ✅ قبول الإيداع - النسخة النهائية الصحيحة
app.post("/admin-approve-deposit", async (req,res)=>{
  try{
    if(!requireAdmin(req,res)) return;

    const email = normalizeEmail(req.body.email);
    const orderId = req.body.orderId;

    const user = await usersCollection.findOne({ email });

    if(!user){
      return res.json({success:false, message:"المستخدم غير موجود"});
    }

    const operations = user.operations || [];
    const opIndex = operations.findIndex(op => op.orderId === orderId);

    if(opIndex === -1){
      return res.json({success:false, message:"العملية غير موجودة"});
    }

    const op = operations[opIndex];

    if(op.status !== "pending"){
      return res.json({success:false, message:`العملية بحالة ${op.status}`});
    }

    // تحويل المبلغ لرقم
    const amount = Number(op.amount) || 0;

    // تحديث الحالة
    operations[opIndex].status = "approved";

    if(op.type === "package_deposit"){

      // تحديث المستخدم في عملية واحدة
      await usersCollection.updateOne(
        { email },
        {
          $set: {
            operations,
            packageName: op.packageName || "",
            packagePrice: amount,
            dailyProfit: Number(op.dailyProfit) || 0,
            packageStart: new Date().toISOString(),
            lastProfitAt: new Date().toISOString(),
            packageDurationDays: 280,
            profitDays: 1
          },
          $inc: {
            balance: amount,
            incomeBalance: Number(op.dailyProfit) || 0
          },
          $push: {
            operations: {
              $each: [{
                type: "daily_profit",
                amount: Number(op.dailyProfit) || 0,
                days: 1,
                status: "approved",
                date: new Date().toISOString()
              }],
              $position: 0
            }
          }
        }
      );

      await distributeReferralCommission(user, amount);

      return res.json({success:true, message:"تم قبول الإيداع والباقة"});
    }

    if(op.type === "deposit"){
      await usersCollection.updateOne(
        { email },
        {
          $set: { operations },
          $inc: { balance: amount }
        }
      );

      return res.json({success:true, message:"تم قبول الإيداع"});
    }

    return res.json({success:false, message:"نوع العملية غير معروف"});

  } catch(e){
    console.error("🔥 خطأ في قبول الإيداع:", e);
    res.json({success:false, message:"حدث خطأ في السيرفر"});
  }
});

// رفض الإيداع باستخدام orderId
app.post("/admin-reject-deposit", async (req,res)=>{
  try{
    if(!requireAdmin(req,res)) return;

    const email = normalizeEmail(req.body.email);
    const orderId = req.body.orderId;

    const user = await usersCollection.findOne({ email });

    if(!user){
      return res.json({success:false, message:"المستخدم غير موجود"});
    }

    const operations = user.operations || [];
    const opIndex = operations.findIndex(op => op.orderId === orderId);
    
    if(opIndex === -1){
      return res.json({success:false, message:"العملية غير موجودة"});
    }

    if(operations[opIndex].status !== "pending"){
      return res.json({success:false, message:"العملية ليست معلقة"});
    }

    operations[opIndex].status = "rejected";

    await usersCollection.updateOne(
      { email },
      { $set:{ operations } }
    );

    res.json({success:true});

  }catch(e){
    console.log(e);
    res.json({success:false, message:"فشلت العملية"});
  }
});

app.post("/admin-approve-withdraw", async (req,res)=>{
  try{
    if(!requireAdmin(req,res)) return;

    const email = normalizeEmail(req.body.email);
    const index = Number(req.body.index);

    let user = await usersCollection.findOne({ email });

    if(!user){
      return res.json({success:false,message:"المستخدم غير موجود"});
    }

    user = await applyPendingDailyProfit(user);

    const operations = user.operations || [];
    const op = operations[index];

    if(!op){
      return res.json({success:false,message:"العملية غير موجودة"});
    }

    if(op.status === "approved"){
      return res.json({success:false,message:"تمت الموافقة مسبقاً"});
    }

    if(Number(user.balance || 0) < Number(op.amount || 0)){
      return res.json({success:false,message:"الرصيد غير كافي"});
    }

    operations[index].status = "approved";

    await usersCollection.updateOne(
      { email },
      {
        $set:{ operations },
        $inc:{ balance: -Number(op.amount || 0) }
      }
    );

    res.json({success:true});

  }catch(e){
    console.log(e);
    res.json({success:false,message:"فشلت العملية"});
  }
});

app.post("/admin-reject-withdraw", async (req,res)=>{
  try{
    if(!requireAdmin(req,res)) return;

    const email = normalizeEmail(req.body.email);
    const index = Number(req.body.index);

    const user = await usersCollection.findOne({ email });

    if(!user){
      return res.json({success:false,message:"المستخدم غير موجود"});
    }

    const operations = user.operations || [];

    if(!operations[index]){
      return res.json({success:false,message:"العملية غير موجودة"});
    }

    operations[index].status = "rejected";

    await usersCollection.updateOne(
      { email },
      { $set:{ operations } }
    );

    res.json({success:true});

  }catch(e){
    console.log(e);
    res.json({success:false,message:"فشلت العملية"});
  }
});

app.post("/admin-change-password", async (req,res)=>{
  try{
    if(!requireAdmin(req,res)) return;

    const email = normalizeEmail(req.body.email);
    const newPassword = cleanText(req.body.newPassword);

    const user = await usersCollection.findOne({ email });

    if(!user){
      return res.json({success:false,message:"المستخدم غير موجود"});
    }

    await usersCollection.updateOne(
      { email },
      { $set:{ password:newPassword } }
    );

    res.json({success:true});

  }catch(e){
    console.log(e);
    res.json({success:false,message:"فشلت العملية"});
  }
});

app.post("/admin-add-balance", async (req,res)=>{
  try{
    if(!requireAdmin(req,res)) return;

    const email = normalizeEmail(req.body.email);
    const amount = Number(req.body.amount);

    const user = await usersCollection.findOne({ email });

    if(!user){
      return res.json({success:false,message:"المستخدم غير موجود"});
    }

    await usersCollection.updateOne(
      { email },
      {
        $inc:{ balance: amount },
        $push:{
          operations:{
            $each:[{
              type:"admin_add_balance",
              amount,
              status:"approved",
              date:new Date().toISOString()
            }],
            $position:0
          }
        }
      }
    );

    res.json({success:true});

  }catch(e){
    console.log(e);
    res.json({success:false,message:"فشلت العملية"});
  }
});

app.post("/admin-remove-balance", async (req,res)=>{
  try{
    if(!requireAdmin(req,res)) return;

    const email = normalizeEmail(req.body.email);
    const amount = Number(req.body.amount);

    const user = await usersCollection.findOne({ email });

    if(!user){
      return res.json({success:false,message:"المستخدم غير موجود"});
    }

    if(Number(user.balance || 0) < amount){
      return res.json({success:false,message:"الرصيد غير كافي"});
    }

    await usersCollection.updateOne(
      { email },
      {
        $inc:{ balance: -amount },
        $push:{
          operations:{
            $each:[{
              type:"admin_remove_balance",
              amount,
              status:"approved",
              date:new Date().toISOString()
            }],
            $position:0
          }
        }
      }
    );

    res.json({success:true});

  }catch(e){
    console.log(e);
    res.json({success:false,message:"فشلت العملية"});
  }
});

app.post("/admin-ban-user", async (req,res)=>{
  try{
    if(!requireAdmin(req,res)) return;

    const email = normalizeEmail(req.body.email);

    await usersCollection.updateOne(
      { email },
      { $set:{ isBanned:true } }
    );

    res.json({success:true});

  }catch(e){
    console.log(e);
    res.json({success:false,message:"فشلت العملية"});
  }
});

app.post("/admin-unban-user", async (req,res)=>{
  try{
    if(!requireAdmin(req,res)) return;

    const email = normalizeEmail(req.body.email);

    await usersCollection.updateOne(
      { email },
      { $set:{ isBanned:false } }
    );

    res.json({success:true});

  }catch(e){
    console.log(e);
    res.json({success:false,message:"فشلت العملية"});
  }
});

app.post("/admin-freeze-user", async (req,res)=>{
  try{
    if(!requireAdmin(req,res)) return;

    const email = normalizeEmail(req.body.email);

    await usersCollection.updateOne(
      { email },
      { $set:{ isFrozen:true } }
    );

    res.json({success:true});

  }catch(e){
    console.log(e);
    res.json({success:false,message:"فشلت العملية"});
  }
});

app.post("/admin-unfreeze-user", async (req,res)=>{
  try{
    if(!requireAdmin(req,res)) return;

    const email = normalizeEmail(req.body.email);

    await usersCollection.updateOne(
      { email },
      { $set:{ isFrozen:false } }
    );

    res.json({success:true});

  }catch(e){
    console.log(e);
    res.json({success:false,message:"فشلت العملية"});
  }
});

app.post("/admin-delete-user", async (req,res)=>{
  try{
    if(!requireAdmin(req,res)) return;

    const email = normalizeEmail(req.body.email);

    await usersCollection.updateOne(
      { email },
      { $set:{ isDeleted:true } }
    );

    res.json({success:true});

  }catch(e){
    console.log(e);
    res.json({success:false,message:"فشلت العملية"});
  }
});

app.post("/admin-set-package", async (req,res)=>{
  try{
    if(!requireAdmin(req,res)) return;

    const email = normalizeEmail(req.body.email);
    const packageName = cleanText(req.body.packageName);
    const info = getPackageInfo(packageName);

    if(!info){
      return res.json({success:false,message:"الباقة غير صحيحة"});
    }

    await usersCollection.updateOne(
      { email },
      {
        $set:{
          packageName:info.name,
          packagePrice:info.price,
          dailyProfit:info.dailyProfit,
          packageStart:new Date().toISOString(),
          lastProfitAt: new Date().toISOString(),
          packageDurationDays:info.durationDays,
          profitDays:1
        },
        $inc: { incomeBalance: info.dailyProfit },
        $push:{
          operations: {
            $each: [
              {
                type:"admin_set_package",
                amount:info.price,
                packageName:info.name,
                status:"approved",
                date:new Date().toISOString()
              },
              {
                type:"daily_profit",
                amount: info.dailyProfit,
                days: 1,
                status:"approved",
                date:new Date().toISOString()
              }
            ],
            $position:0
          }
        }
      }
    );

    res.json({success:true});

  }catch(e){
    console.log(e);
    res.json({success:false,message:"فشلت العملية"});
  }
});

/* ---------------- SEND VERIFICATION ---------------- */

app.post("/submit-verification", upload.single("file"), async (req,res)=>{
  try{

    const email = normalizeEmail(req.body.email);
    const fullName = cleanText(req.body.fullName);
    const docType = cleanText(req.body.docType);
    const docNumber = cleanText(req.body.docNumber);
    const note = cleanText(req.body.note);

    if(!req.file){
      return res.json({success:false,message:"الصورة مطلوبة"});
    }

    const fileUrl = "/uploads/" + req.file.filename;

    await verifyCollection.updateOne(
      { email },
      {
        $set:{
          email,
          fullName,
          docType,
          docNumber,
          note,
          fileUrl,
          status:"pending",
          createdAt:new Date().toISOString()
        }
      },
      { upsert:true }
    );

    res.json({success:true});

  }catch(e){
    console.log(e);
    res.json({success:false,message:"فشل إرسال التوثيق"});
  }
});

/* ---------------- ADMIN VERIFICATIONS ---------------- */

app.get("/admin-verifications", async (req,res)=>{
  try{
    if(!requireAdmin(req,res)) return;

    const list = await verifyCollection.find().toArray();

    res.json({success:true,verifications:list});

  }catch(e){
    console.log(e);
    res.json({success:false});
  }
});

app.post("/admin-approve-verification", async (req,res)=>{
  try{
    if(!requireAdmin(req,res)) return;

    const email = normalizeEmail(req.body.email);

    await verifyCollection.updateOne(
      { email },
      { $set:{ status:"approved" } }
    );

    res.json({success:true});

  }catch(e){
    console.log(e);
    res.json({success:false});
  }
});

app.post("/admin-reject-verification", async (req,res)=>{
  try{
    if(!requireAdmin(req,res)) return;

    const email = normalizeEmail(req.body.email);

    await verifyCollection.updateOne(
      { email },
      { $set:{ status:"rejected" } }
    );

    res.json({success:true});

  }catch(e){
    console.log(e);
    res.json({success:false});
  }
});

/* ---------------- MY VERIFICATION ---------------- */

app.post("/my-verification", async (req,res)=>{
  try{

    const email = normalizeEmail(req.body.email);

    if(!email){
      return res.json({
        success:false,
        message:"البريد مطلوب"
      });
    }

    const verification = await verifyCollection.findOne({ email });

    if(!verification){
      return res.json({
        success:true,
        verification:null
      });
    }

    res.json({
      success:true,
      verification:{
        fullName: verification.fullName,
        docType: verification.docType,
        docNumber: verification.docNumber,
        note: verification.note,
        fileUrl: verification.fileUrl,
        status: verification.status,
        createdAt: verification.createdAt
      }
    });

  }catch(e){
    console.log(e);

    res.json({
      success:false,
      message:"فشل تحميل حالة التوثيق"
    });
  }
});

/* ---------------- MANUAL DEPOSIT ---------------- */

app.post("/manual-deposit", async (req,res)=>{
  try{

    const email = normalizeEmail(req.body.email);
    const amount = Number(req.body.amount);
    const packageName = cleanText(req.body.packageName);

    const packageInfo = getPackageInfo(packageName);

    const orderId = req.body.orderId;

    await usersCollection.updateOne(
      { email },
      {
        $push:{
          operations:{
            $each:[{
              orderId,
              type:"package_deposit",
              amount,
              network:"USDT-TRC20",
              status:"pending",
              packageName,
              dailyProfit: packageInfo?.dailyProfit || 0,
              txid:"",
              proof:"",
              expiresAt: Date.now() + (30 * 60 * 1000),
              date:new Date().toISOString()
            }],
            $position:0
          }
        }
      }
    );

    res.json({success:true});

  }catch(e){
    console.log(e);
    res.json({success:false});
  }
});

/* ---------------- UPLOAD PROOF ---------------- */

app.post("/upload-proof", upload.single("file"), async (req,res)=>{
  try{

    const email = req.body.email;
    const txid = req.body.txid;
    const orderId = req.body.orderId;

    const fileUrl = "/uploads/" + req.file.filename;

    const user = await usersCollection.findOne({ email });
    if (!user) {
      return res.json({ success: false, message: "المستخدم غير موجود" });
    }

    const op = user.operations.find(o => o.orderId === orderId);
    if (op && op.txid) {
      return res.json({ success: false, message: "تم الإرسال مسبقاً" });
    }

    await usersCollection.updateOne(
      { email, "operations.orderId": orderId },
      {
        $set:{
          "operations.$.txid": txid,
          "operations.$.proof": fileUrl
        }
      }
    );

    res.json({
      success:true,
      file:fileUrl
    });

  }catch(e){
    console.log(e);
    res.json({success:false});
  }
});

/* ---------------- DATABASE CONNECT ---------------- */

async function connectDB(){
  try{
    await client.connect();
    db = client.db("sudan_crypto");
    usersCollection = db.collection("users");
    otpCollection = db.collection("otps");
    verifyCollection = db.collection("verifications");

    console.log("Connected to MongoDB");

    // تشغيل فوري عند بدء السيرفر
    cancelExpiredDepositsNow();
    
    // تشغيل كل دقيقة
    setInterval(() => {
      cancelExpiredDepositsNow();
    }, 60 * 1000);

    // تشغيل المهمة اليومية للربح
    cron.schedule("0 0 * * *", () => {
      console.log("Running daily profit job...");
      runDailyProfitForAllUsers();
    });

    // تشغيل مرة عند بدء التشغيل لحساب الأرباح المتراكمة
    setTimeout(() => {
      runDailyProfitForAllUsers();
    }, 5000);

  }catch(e){
    console.log("DB Connection Error:", e);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async ()=>{
  await connectDB();
  console.log("Server running on port", PORT);
});
