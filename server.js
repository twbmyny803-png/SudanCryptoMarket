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
const PACKAGE_DURATION_DAYS = 280;

/* ---------------- FUNCTIONS ---------------- */

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

function requireAdmin(req,res){

const token=req.headers["x-admin-token"]

if(!token || !adminSessions[token]){
res.json({success:false,message:"غير مصرح"})
return false
}

return true
}

function getPackageInfo(pack){

const p=cleanText(pack).toLowerCase()

if(p==="starter"){
return {name:"Starter",price:50,dailyProfit:2.5,durationDays:PACKAGE_DURATION_DAYS}
}

if(p==="silver"){
return {name:"Silver",price:100,dailyProfit:5,durationDays:PACKAGE_DURATION_DAYS}
}

if(p==="gold"){
return {name:"Gold",price:250,dailyProfit:8,durationDays:PACKAGE_DURATION_DAYS}
}

if(p==="diamond"){
return {name:"Diamond",price:500,dailyProfit:12,durationDays:PACKAGE_DURATION_DAYS}
}

if(p==="platinum"){
return {name:"Platinum",price:1000,dailyProfit:25,durationDays:PACKAGE_DURATION_DAYS}
}

return null
}

/* ---------------- ROOT ---------------- */

app.get("/",(req,res)=>{
res.json({success:true,message:"Sudan Crypto API running"})
})

/* ---------------- ADMIN LOGIN ---------------- */

app.post("/admin-login",(req,res)=>{

const username=cleanText(req.body.username)
const password=cleanText(req.body.password)

if(username!==ADMIN_USERNAME || password!==ADMIN_PASSWORD){
return res.json({success:false,message:"بيانات الأدمن غير صحيحة"})
}

const token=generateToken()

adminSessions[token]={createdAt:Date.now()}

res.json({success:true,token})

})

/* ---------------- SEND OTP ---------------- */

app.post("/send-code", async (req,res)=>{

try{

const email=normalizeEmail(req.body.email)

if(!email) return res.json({success:false,message:"البريد مطلوب"})

if(!isValidEmail(email)) return res.json({success:false,message:"بريد غير صحيح"})

const code=generateOTP()

otpStore[email]={
code,
expiresAt:Date.now()+OTP_EXPIRES_MS,
verified:false
}

await resend.emails.send({
from:"Sudan Crypto <noreply@sudancrypto.com>",
to:email,
subject:"رمز التحقق",
html:`<h2>${code}</h2>`
})

res.json({success:true})

}catch(e){

console.log(e)

res.json({success:false,message:"فشل ارسال الكود"})

}

})

/* ---------------- VERIFY OTP ---------------- */

app.post("/verify-code",(req,res)=>{

const email=normalizeEmail(req.body.email)
const code=cleanText(req.body.code)

const saved=otpStore[email]

if(!saved) return res.json({success:false,message:"لم يتم طلب كود"})

if(saved.code!==code) return res.json({success:false,message:"الكود غير صحيح"})

if(Date.now()>saved.expiresAt) return res.json({success:false,message:"انتهت صلاحية الكود"})

otpStore[email].verified=true

res.json({success:true})

})

/* ---------------- REGISTER ---------------- */

app.post("/register",(req,res)=>{

const name=cleanText(req.body.name)
const email=normalizeEmail(req.body.email)
const phone=cleanText(req.body.phone)
const password=cleanText(req.body.password)

const saved=otpStore[email]

if(!saved || saved.verified!==true){
return res.json({success:false,message:"يجب التحقق من البريد"})
}

if(users[email]){
return res.json({success:false,message:"البريد مسجل"})
}

users[email]={
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

delete otpStore[email]

res.json({success:true})

})

/* ---------------- LOGIN ---------------- */

app.post("/login",(req,res)=>{

const email=normalizeEmail(req.body.email)
const password=cleanText(req.body.password)

const user=users[email]

if(!user){
return res.json({success:false,message:"الحساب غير موجود"})
}

if(user.isDeleted){
return res.json({success:false,message:"الحساب محذوف"})
}

if(user.isBanned){
return res.json({success:false,message:"الحساب محظور"})
}

if(user.isFrozen){
return res.json({success:false,message:"الحساب مجمد"})
}

if(user.password!==password){
return res.json({success:false,message:"كلمة السر خطأ"})
}

res.json({success:true,user})

})

/* ---------------- USER DATA ---------------- */

app.post("/user-data",(req,res)=>{

const email=normalizeEmail(req.body.email)

const user=users[email]

if(!user || user.isDeleted) return res.json({success:false})

res.json({
success:true,
name:user.name,
email:user.email,
phone:user.phone||"",
balance:user.balance,
operations:user.operations,
packageName:user.packageName||"",
dailyProfit:user.dailyProfit||0
})

})

/* ---------------- DEPOSIT ---------------- */

app.post("/deposit",(req,res)=>{

const email=normalizeEmail(req.body.email)
const amount=Number(req.body.amount)
const network=cleanText(req.body.network)
const txid=cleanText(req.body.txid)

const user=users[email]

if(!user || user.isDeleted) return res.json({success:false})

user.operations.unshift({
type:"deposit",
amount,
network,
txid,
status:"pending",
date:new Date().toISOString()
})

res.json({success:true})

})

/* ---------------- WITHDRAW ---------------- */

app.post("/withdraw",(req,res)=>{

const email=normalizeEmail(req.body.email)
const amount=Number(req.body.amount)
const network=cleanText(req.body.network)

const user=users[email]

if(!user || user.isDeleted) return res.json({success:false})

if(user.balance<amount){
return res.json({success:false,message:"الرصيد غير كافي"})
}

user.operations.unshift({
type:"withdraw",
amount,
network,
status:"pending",
date:new Date().toISOString()
})

res.json({success:true})

})

/* ---------------- ADMIN USERS ---------------- */

app.get("/admin-users",(req,res)=>{

if(!requireAdmin(req,res)) return

const list=Object.values(users).filter(u=>!u.isDeleted)

res.json({success:true,users:list})

})

/* ---------------- ADMIN DEPOSITS ---------------- */

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
currency:"USDT",
network:op.network||"",
txid:op.txid||"",
status:op.status,
index
})

}

})

})

res.json({success:true,deposits})

})

/* ---------------- ADMIN WITHDRAWS ---------------- */

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
currency:"USDT",
network:op.network||"",
status:op.status,
index
})

}

})

})

res.json({success:true,withdraws:list})

})

/* ---------------- APPROVE DEPOSIT ---------------- */

app.post("/admin-approve-deposit",(req,res)=>{

if(!requireAdmin(req,res)) return

const email=normalizeEmail(req.body.email)
const index=Number(req.body.index)

const user=users[email]

if(!user) return res.json({success:false,message:"المستخدم غير موجود"})

const op=user.operations[index]

if(!op) return res.json({success:false,message:"العملية غير موجودة"})

if(op.status==="approved") return res.json({success:false,message:"تمت الموافقة مسبقاً"})

op.status="approved"

user.balance+=Number(op.amount||0)

res.json({success:true})

})

/* ---------------- REJECT DEPOSIT ---------------- */

app.post("/admin-reject-deposit",(req,res)=>{

if(!requireAdmin(req,res)) return

const email=normalizeEmail(req.body.email)
const index=Number(req.body.index)

const user=users[email]

if(!user) return res.json({success:false,message:"المستخدم غير موجود"})

const op=user.operations[index]

if(!op) return res.json({success:false,message:"العملية غير موجودة"})

op.status="rejected"

res.json({success:true})

})

/* ---------------- APPROVE WITHDRAW ---------------- */

app.post("/admin-approve-withdraw",(req,res)=>{

if(!requireAdmin(req,res)) return

const email=normalizeEmail(req.body.email)
const index=Number(req.body.index)

const user=users[email]

if(!user) return res.json({success:false,message:"المستخدم غير موجود"})

const op=user.operations[index]

if(!op) return res.json({success:false,message:"العملية غير موجودة"})

if(op.status==="approved") return res.json({success:false,message:"تمت الموافقة مسبقاً"})

op.status="approved"

user.balance-=Number(op.amount||0)

res.json({success:true})

})

/* ---------------- REJECT WITHDRAW ---------------- */

app.post("/admin-reject-withdraw",(req,res)=>{

if(!requireAdmin(req,res)) return

const email=normalizeEmail(req.body.email)
const index=Number(req.body.index)

const user=users[email]

if(!user) return res.json({success:false,message:"المستخدم غير موجود"})

const op=user.operations[index]

if(!op) return res.json({success:false,message:"العملية غير موجودة"})

op.status="rejected"

res.json({success:true})

})

/* ---------------- ADMIN CHANGE PASSWORD ---------------- */

app.post("/admin-change-password",(req,res)=>{

if(!requireAdmin(req,res)) return

const email=normalizeEmail(req.body.email)
const newPassword=cleanText(req.body.newPassword)

const user=users[email]

if(!user) return res.json({success:false,message:"المستخدم غير موجود"})

user.password=newPassword

res.json({success:true})

})

/* ---------------- ADMIN ADD BALANCE ---------------- */

app.post("/admin-add-balance",(req,res)=>{

if(!requireAdmin(req,res)) return

const email=normalizeEmail(req.body.email)
const amount=Number(req.body.amount)

const user=users[email]

if(!user) return res.json({success:false,message:"المستخدم غير موجود"})

user.balance+=amount

user.operations.unshift({
type:"admin_add_balance",
amount,
status:"approved",
date:new Date().toISOString()
})

res.json({success:true})

})

/* ---------------- ADMIN REMOVE BALANCE ---------------- */

app.post("/admin-remove-balance",(req,res)=>{

if(!requireAdmin(req,res)) return

const email=normalizeEmail(req.body.email)
const amount=Number(req.body.amount)

const user=users[email]

if(!user) return res.json({success:false,message:"المستخدم غير موجود"})

if(user.balance<amount){
return res.json({success:false,message:"الرصيد غير كافي"})
}

user.balance-=amount

user.operations.unshift({
type:"admin_remove_balance",
amount,
status:"approved",
date:new Date().toISOString()
})

res.json({success:true})

})

/* ---------------- ADMIN BAN USER ---------------- */

app.post("/admin-ban-user",(req,res)=>{

if(!requireAdmin(req,res)) return

const email=normalizeEmail(req.body.email)
const user=users[email]

if(!user) return res.json({success:false,message:"المستخدم غير موجود"})

user.isBanned=true

res.json({success:true})

})

/* ---------------- ADMIN UNBAN USER ---------------- */

app.post("/admin-unban-user",(req,res)=>{

if(!requireAdmin(req,res)) return

const email=normalizeEmail(req.body.email)
const user=users[email]

if(!user) return res.json({success:false,message:"المستخدم غير موجود"})

user.isBanned=false

res.json({success:true})

})

/* ---------------- ADMIN FREEZE USER ---------------- */

app.post("/admin-freeze-user",(req,res)=>{

if(!requireAdmin(req,res)) return

const email=normalizeEmail(req.body.email)
const user=users[email]

if(!user) return res.json({success:false,message:"المستخدم غير موجود"})

user.isFrozen=true

res.json({success:true})

})

/* ---------------- ADMIN UNFREEZE USER ---------------- */

app.post("/admin-unfreeze-user",(req,res)=>{

if(!requireAdmin(req,res)) return

const email=normalizeEmail(req.body.email)
const user=users[email]

if(!user) return res.json({success:false,message:"المستخدم غير موجود"})

user.isFrozen=false

res.json({success:true})

})

/* ---------------- ADMIN DELETE USER ---------------- */

app.post("/admin-delete-user",(req,res)=>{

if(!requireAdmin(req,res)) return

const email=normalizeEmail(req.body.email)
const user=users[email]

if(!user) return res.json({success:false,message:"المستخدم غير موجود"})

user.isDeleted=true

res.json({success:true})

})

/* ---------------- ADMIN SET PACKAGE ---------------- */

app.post("/admin-set-package",(req,res)=>{

if(!requireAdmin(req,res)) return

const email=normalizeEmail(req.body.email)
const pack=cleanText(req.body.package)

const user=users[email]

if(!user) return res.json({success:false,message:"المستخدم غير موجود"})

const info=getPackageInfo(pack)

if(!info){
return res.json({success:false,message:"الباقة غير صحيحة"})
}

user.packageName=info.name
user.packagePrice=info.price
user.dailyProfit=info.dailyProfit
user.packageStart=Date.now()
user.packageDurationDays=info.durationDays

user.operations.unshift({
type:"admin_set_package",
amount:info.price,
packageName:info.name,
status:"approved",
date:new Date().toISOString()
})

res.json({success:true})

})

const PORT = process.env.PORT || 10000

app.listen(PORT,()=>{
console.log("Server running on port "+PORT)
})
