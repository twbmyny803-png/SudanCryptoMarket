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
return String(email||"").trim().toLowerCase()
}

function cleanText(v){
return String(v||"").trim()
}

function generateOTP(){
return Math.floor(100000 + Math.random()*900000).toString()
}

function generateToken(){
return crypto.randomBytes(24).toString("hex")
}

function isValidEmail(email){
return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function ensureUserCanUseAccount(user){

if(!user) return {ok:false,message:"الحساب غير موجود"}
if(user.isDeleted) return {ok:false,message:"الحساب محذوف"}
if(user.isBanned) return {ok:false,message:"الحساب محظور"}
if(user.isFrozen) return {ok:false,message:"الحساب مجمد"}

return {ok:true}

}

function isAdminAuthorized(req){

const token=req.headers["x-admin-token"]

if(token && adminSessions[token]){
return true
}

return false

}

function requireAdmin(req,res){

if(!isAdminAuthorized(req)){
res.json({success:false,message:"غير مصرح"})
return false
}

return true

}

/* ================= ADMIN LOGIN ================= */

app.post("/admin-login",(req,res)=>{

const username=cleanText(req.body.username)
const password=cleanText(req.body.password)

if(username!==ADMIN_USERNAME||password!==ADMIN_PASSWORD){
return res.json({success:false,message:"بيانات الأدمن غير صحيحة"})
}

const token=generateToken()

adminSessions[token]={createdAt:Date.now()}

res.json({success:true,token})

})

/* ================= USER REGISTER ================= */

app.post("/register",(req,res)=>{

const name=cleanText(req.body.name)
const email=normalizeEmail(req.body.email)
const phone=cleanText(req.body.phone)
const password=cleanText(req.body.password)

if(users[email]){
return res.json({success:false,message:"البريد مسجل"})
}

users[email]={
id:Date.now().toString(),
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
isBanned:false,
isFrozen:false,
isDeleted:false,
createdAt:new Date().toISOString()
}

res.json({success:true})

})

/* ================= LOGIN ================= */

app.post("/login",(req,res)=>{

const email=normalizeEmail(req.body.email)
const password=cleanText(req.body.password)

const user=users[email]

const canUse=ensureUserCanUseAccount(user)

if(!canUse.ok){
return res.json({success:false,message:canUse.message})
}

if(user.password!==password){
return res.json({success:false,message:"كلمة السر خطأ"})
}

res.json({success:true,user})

})

/* ================= USER DATA ================= */

app.post("/user-data",(req,res)=>{

const email=normalizeEmail(req.body.email)

const user=users[email]

if(!user){
return res.json({success:false})
}

res.json({
success:true,
name:user.name,
balance:user.balance,
operations:user.operations,
packageName:user.packageName
})

})

/* ================= DEPOSIT ================= */

app.post("/deposit",(req,res)=>{

const email=normalizeEmail(req.body.email)
const amount=Number(req.body.amount)

const user=users[email]

if(!user){
return res.json({success:false})
}

user.operations.unshift({
type:"deposit",
amount,
status:"pending",
date:new Date().toISOString()
})

res.json({success:true})

})

/* ================= WITHDRAW ================= */

app.post("/withdraw",(req,res)=>{

const email=normalizeEmail(req.body.email)
const amount=Number(req.body.amount)

const user=users[email]

if(!user){
return res.json({success:false})
}

if(user.balance<amount){
return res.json({success:false,message:"الرصيد غير كافي"})
}

user.operations.unshift({
type:"withdraw",
amount,
status:"pending",
date:new Date().toISOString()
})

res.json({success:true})

})

/* ================= ADMIN USERS ================= */

app.get("/admin-users",(req,res)=>{

if(!requireAdmin(req,res)) return

const list=Object.values(users).filter(u=>!u.isDeleted)

res.json({success:true,users:list})

})

/* ================= ADMIN DEPOSITS ================= */

app.get("/admin-deposits",(req,res)=>{

if(!requireAdmin(req,res)) return

let deposits=[]

Object.values(users).forEach(user=>{

user.operations.forEach((op,index)=>{

if(op.type==="deposit"){
deposits.push({
id:user.email+"_"+index,
email:user.email,
name:user.name,
amount:op.amount,
status:op.status,
index
})
}

})

})

res.json({success:true,deposits})

})

/* ================= ADMIN WITHDRAWS ================= */

app.get("/admin-withdraws",(req,res)=>{

if(!requireAdmin(req,res)) return

let list=[]

Object.values(users).forEach(user=>{

user.operations.forEach((op,index)=>{

if(op.type==="withdraw"){
list.push({
id:user.email+"_"+index,
email:user.email,
name:user.name,
amount:op.amount,
status:op.status,
index
})
}

})

})

res.json({success:true,withdraws:list})

})

/* ================= APPROVE DEPOSIT ================= */

app.post("/admin-approve-deposit",(req,res)=>{

if(!requireAdmin(req,res)) return

const email=req.body.email
const index=req.body.index

const user=users[email]

if(!user) return res.json({success:false})

const op=user.operations[index]

if(!op) return res.json({success:false})

op.status="approved"

user.balance+=op.amount

res.json({success:true})

})

/* ================= REJECT DEPOSIT ================= */

app.post("/admin-reject-deposit",(req,res)=>{

if(!requireAdmin(req,res)) return

const email=req.body.email
const index=req.body.index

const user=users[email]

if(!user) return res.json({success:false})

const op=user.operations[index]

if(!op) return res.json({success:false})

op.status="rejected"

res.json({success:true})

})

/* ================= APPROVE WITHDRAW ================= */

app.post("/admin-approve-withdraw",(req,res)=>{

if(!requireAdmin(req,res)) return

const email=req.body.email
const index=req.body.index

const user=users[email]

if(!user) return res.json({success:false})

const op=user.operations[index]

if(!op) return res.json({success:false})

op.status="approved"

user.balance-=op.amount

res.json({success:true})

})

/* ================= REJECT WITHDRAW ================= */

app.post("/admin-reject-withdraw",(req,res)=>{

if(!requireAdmin(req,res)) return

const email=req.body.email
const index=req.body.index

const user=users[email]

if(!user) return res.json({success:false})

const op=user.operations[index]

if(!op) return res.json({success:false})

op.status="rejected"

res.json({success:true})

})

/* ================= ADMIN CHANGE PASSWORD ================= */

app.post("/admin-change-password",(req,res)=>{

if(!requireAdmin(req,res)) return

const email=normalizeEmail(req.body.email)
const newPassword=cleanText(req.body.newPassword)

const user=users[email]

if(!user) return res.json({success:false})

user.password=newPassword

res.json({success:true})

})

const PORT=process.env.PORT||10000

app.listen(PORT,()=>{
console.log("Server running on port "+PORT)
})
