const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Resend } = require("resend");
const { MongoClient } = require("mongodb");

const app = express();

app.use(cors());
app.use(express.json());

const resend = new Resend(process.env.RESEND_API_KEY);

const client = new MongoClient(process.env.MONGODB_URI);

let db;
let usersCollection;
let otpCollection;

const adminSessions = {};

const ADMIN_USERNAME = "admain";
const ADMIN_PASSWORD = "admin_2050";

const OTP_EXPIRES_MS = 5 * 60 * 1000;
const PACKAGE_DURATION_DAYS = 280;

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
  if(!user.packageName || !user.packageStart || !user.dailyProfit){
    return user;
  }

  const start = new Date(user.packageStart).getTime();
  if(!start){
    return user;
  }

  const daysPassed = Math.floor((Date.now() - start) / (1000 * 60 * 60 * 24));
  const totalEligibleDays = Math.min(Math.max(daysPassed, 0), Number(user.packageDurationDays || 0));
  const creditedDays = Number(user.profitCreditedDays || 0);

  if(totalEligibleDays <= creditedDays){
    return user;
  }

  const newDays = totalEligibleDays - creditedDays;
  const profitToAdd = newDays * Number(user.dailyProfit || 0);

  const operation = {
    type:"daily_profit",
    amount:profitToAdd,
    status:"approved",
    date:new Date().toISOString()
  };

  await usersCollection.updateOne(
    { email:user.email },
    {
      $inc:{
        balance: profitToAdd,
        profitCreditedDays: newDays
      },
      $push:{
        operations:{
          $each:[operation],
          $position:0
        }
      }
    }
  );

  return await usersCollection.findOne({ email:user.email });
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

    const saved = await otpCollection.findOne({ email });
    const existingUser = await usersCollection.findOne({ email });

    if(!saved || saved.verified !== true){
      return res.json({success:false,message:"يجب التحقق من البريد"});
    }

    if(existingUser){
      return res.json({success:false,message:"البريد مسجل"});
    }

    await usersCollection.insertOne({
      name,
      email,
      phone,
      password,
      balance:0,
      operations:[],
      packageName:"",
      packagePrice:0,
      dailyProfit:0,
      packageStart:null,
      packageDurationDays:0,
      profitCreditedDays:0,
      isBanned:false,
      isFrozen:false,
      isDeleted:false,
      createdAt:new Date().toISOString()
    });

    await otpCollection.deleteOne({ email });

    res.json({success:true});

  }catch(e){
    console.log(e);
    res.json({success:false,message:"فشل إنشاء الحساب"});
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

    res.json({success:true,user});

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
      balance:user.balance,
      operations:user.operations || [],
      packageName:user.packageName || "",
      packagePrice:user.packagePrice || 0,
      dailyProfit:user.dailyProfit || 0,
      packageStart:user.packageStart || null,
      packageDurationDays:user.packageDurationDays || 0,
      accruedProfit: calculateDailyAccruedProfit(user)
    });

  }catch(e){
    console.log(e);
    res.json({success:false,message:"فشل تحميل البيانات"});
  }
});

/* ---------------- DEPOSIT ---------------- */

app.post("/deposit", async (req,res)=>{
  try{
    const email = normalizeEmail(req.body.email);
    const amount = Number(req.body.amount);
    const network = cleanText(req.body.network);
    const txid = cleanText(req.body.txid);
    const packageName = cleanText(req.body.packageName);

    const user = await usersCollection.findOne({ email });

    if(!user || user.isDeleted){
      return res.json({success:false});
    }

    let operation = {
      type:"deposit",
      amount,
      network,
      txid,
      status:"pending",
      date:new Date().toISOString()
    };

    if(packageName){
      const info = getPackageInfo(packageName);

      if(info){
        operation = {
          type:"package_deposit",
          amount: info.price,
          network,
          txid,
          packageKey: packageName.toLowerCase(),
          packageName: info.name,
          dailyProfit: info.dailyProfit,
          durationDays: info.durationDays,
          status:"pending",
          date:new Date().toISOString()
        };
      }
    }

    await usersCollection.updateOne(
      { email },
      {
        $push:{
          operations:{
            $each:[operation],
            $position:0
          }
        }
      }
    );

    res.json({success:true});

  }catch(e){
    console.log(e);
    res.json({success:false,message:"فشل الإيداع"});
  }
});

/* ---------------- WITHDRAW ---------------- */

app.post("/withdraw", async (req,res)=>{
  try{
    const email = normalizeEmail(req.body.email);
    const amount = Number(req.body.amount);
    const network = cleanText(req.body.network);

    let user = await usersCollection.findOne({ email });

    if(!user || user.isDeleted){
      return res.json({success:false});
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
    res.json({success:false,message:"فشل تحميل المستخدمين"});
  }
});

/* ---------------- ADMIN DEPOSITS ---------------- */

app.get("/admin-deposits", async (req,res)=>{
  try{
    if(!requireAdmin(req,res)) return;

    const users = await usersCollection.find({ isDeleted:{ $ne:true } }).toArray();

    const deposits = [];

    users.forEach(user=>{
      (user.operations || []).forEach((op,index)=>{
        if(op.type === "deposit" || op.type === "package_deposit"){
          deposits.push({
            id:user.email + "_" + index,
            email:user.email,
            name:user.name,
            amount:op.amount,
            currency:"USDT",
            network:op.network || "",
            txid:op.txid || "",
            packageName:op.packageName || "",
            status:op.status,
            index
          });
        }
      });
    });

    res.json({success:true,deposits});

  }catch(e){
    console.log(e);
    res.json({success:false,message:"فشل تحميل طلبات الإيداع"});
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

/* ---------------- APPROVE DEPOSIT ---------------- */

app.post("/admin-approve-deposit", async (req,res)=>{
  try{
    if(!requireAdmin(req,res)) return;

    const email = normalizeEmail(req.body.email);
    const index = Number(req.body.index);

    const user = await usersCollection.findOne({ email });

    if(!user){
      return res.json({success:false,message:"المستخدم غير موجود"});
    }

    const operations = user.operations || [];
    const op = operations[index];

    if(!op){
      return res.json({success:false,message:"العملية غير موجودة"});
    }

    if(op.status === "approved"){
      return res.json({success:false,message:"تمت الموافقة مسبقاً"});
    }

    operations[index].status = "approved";

    const updateData = {
      operations
    };

    if(op.type === "deposit"){
      updateData.balance = Number(user.balance || 0) + Number(op.amount || 0);
    }

    if(op.type === "package_deposit"){
      updateData.packageName = op.packageName || "";
      updateData.packagePrice = Number(op.amount || 0);
      updateData.dailyProfit = Number(op.dailyProfit || 0);
      updateData.packageStart = new Date().toISOString();
      updateData.packageDurationDays = Number(op.durationDays || 0);
      updateData.profitCreditedDays = 0;
    }

    await usersCollection.updateOne(
      { email },
      { $set:updateData }
    );

    res.json({success:true});

  }catch(e){
    console.log(e);
    res.json({success:false,message:"فشلت العملية"});
  }
});

/* ---------------- REJECT DEPOSIT ---------------- */

app.post("/admin-reject-deposit", async (req,res)=>{
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

/* ---------------- APPROVE WITHDRAW ---------------- */

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

/* ---------------- REJECT WITHDRAW ---------------- */

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

/* ---------------- ADMIN CHANGE PASSWORD ---------------- */

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

/* ---------------- ADMIN ADD BALANCE ---------------- */

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

/* ---------------- ADMIN REMOVE BALANCE ---------------- */

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

/* ---------------- ADMIN BAN USER ---------------- */

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

/* ---------------- ADMIN UNBAN USER ---------------- */

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

/* ---------------- ADMIN FREEZE USER ---------------- */

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

/* ---------------- ADMIN UNFREEZE USER ---------------- */

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

/* ---------------- ADMIN DELETE USER ---------------- */

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

/* ---------------- ADMIN SET PACKAGE ---------------- */

app.post("/admin-set-package", async (req,res)=>{
  try{
    if(!requireAdmin(req,res)) return;

    const email = normalizeEmail(req.body.email);
    const pack = cleanText(req.body.package);

    const info = getPackageInfo(pack);

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
          packageDurationDays:info.durationDays,
          profitCreditedDays:0
        },
        $push:{
          operations:{
            $each:[{
              type:"admin_set_package",
              amount:info.price,
              packageName:info.name,
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

/* ---------------- START SERVER ---------------- */

async function startServer(){
  try{
    await client.connect();

    db = client.db("sudancrypto");
    usersCollection = db.collection("users");
    otpCollection = db.collection("otp_codes");

    await usersCollection.createIndex({ email:1 }, { unique:true });
    await otpCollection.createIndex({ email:1 }, { unique:true });

    console.log("MongoDB connected");

    const PORT = process.env.PORT || 10000;

    app.listen(PORT,()=>{
      console.log("Server running on port " + PORT);
    });

  }catch(e){
    console.log("MongoDB connection error:", e);
    process.exit(1);
  }
}

startServer();
