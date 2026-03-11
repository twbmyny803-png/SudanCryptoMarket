const express = require("express");
const cors = require("cors");
const { Resend } = require("resend");

const app = express();

app.use(cors());
app.use(express.json());

const resend = new Resend(process.env.RESEND_API_KEY);

const otpStore = {};
const users = {};

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

function isValidEmail(email){
return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function isOtpValid(saved,code,purpose){

if(!saved){
return {ok:false,message:"لم يتم طلب كود"}
}

if(saved.purpose!==purpose){
return {ok:false,message:"نوع الكود غير صحيح"}
}

if(Date.now()>saved.expiresAt){
return {ok:false,message:"انتهت صلاحية الكود"}
}

if(saved.code!==code){
return {ok:false,message:"الكود غير صحيح"}
}

return {ok:true}
}

function generateReferralCode(name,email){

const part1=cleanText(name||email||"USR")
.replace(/\s+/g,"")
.replace(/[^a-zA-Z0-9]/g,"")
.toUpperCase()
.slice(0,3) || "USR"

const part2=Math.floor(100+Math.random()*900).toString()

return part1+part2
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

function calculateProfit(user){

if(!user.packageName || !user.packageStart){
return 0
}

const daysPassed=Math.floor((Date.now()-user.packageStart)/(1000*60*60*24))

const payableDays=Math.min(daysPassed,user.packageDurationDays)

return payableDays*(user.dailyProfit||0)
}

app.get("/",(req,res)=>{
res.json({success:true,message:"Sudan Crypto API running"})
})

/* ارسال كود */
app.post("/send-code",async(req,res)=>{
try{

const email=normalizeEmail(req.body.email)
const purpose=cleanText(req.body.purpose||"register")

if(!email){
return res.json({success:false,message:"البريد مطلوب"})
}

if(!isValidEmail(email)){
return res.json({success:false,message:"بريد غير صحيح"})
}

if(purpose==="register" && users[email]){
return res.json({success:false,message:"البريد مسجل"})
}

const code=generateOTP()

otpStore[email]={
code,
purpose,
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

/* تحقق الكود */
app.post("/verify-code",(req,res)=>{

const email=normalizeEmail(req.body.email)
const code=cleanText(req.body.code)
const purpose=cleanText(req.body.purpose||"register")

const saved=otpStore[email]
const check=isOtpValid(saved,code,purpose)

if(!check.ok){
return res.json({success:false,message:check.message})
}

otpStore[email].verified=true

res.json({success:true})

})

/* تسجيل مستخدم */
app.post("/register",(req,res)=>{

const name=cleanText(req.body.name)
const email=normalizeEmail(req.body.email)
const phone=cleanText(req.body.phone)
const referral=cleanText(req.body.referral)
const password=cleanText(req.body.password)

const saved=otpStore[email]

if(!saved || saved.purpose!=="register" || saved.verified!==true){
return res.json({success:false,message:"يجب التحقق من البريد"})
}

let referralCode=generateReferralCode(name,email)

while(Object.values(users).some(u=>u.referralCode===referralCode)){
referralCode=generateReferralCode(name,email)
}

users[email]={

id:Date.now().toString(),
name,
email,
phone,
referral,
referredBy:referral||"",
referralCode,
password,
balance:0,
operations:[],
packageName:"",
packagePrice:0,
dailyProfit:0,
packageStart:null,
packageDurationDays:0,
createdAt:new Date().toISOString()

}

delete otpStore[email]

res.json({success:true})

})

/* تسجيل دخول */
app.post("/login",(req,res)=>{

const email=normalizeEmail(req.body.email)
const password=cleanText(req.body.password)
const code=cleanText(req.body.code)

const user=users[email]

if(!user){
return res.json({success:false,message:"الحساب غير موجود"})
}

if(user.password!==password){
return res.json({success:false,message:"كلمة السر خطأ"})
}

const saved=otpStore[email]
const check=isOtpValid(saved,code,"login")

if(!check.ok){
return res.json({success:false,message:check.message})
}

delete otpStore[email]

res.json({success:true,user})

})

/* بيانات المستخدم */
app.post("/user-data",(req,res)=>{

const email=normalizeEmail(req.body.email)
const user=users[email]

if(!user){
return res.json({success:false})
}

const teamMembers=Object.values(users)
.filter(u=>u.referredBy===user.referralCode)

const dailyIncome=calculateProfit(user)

res.json({

success:true,
name:user.name,
balance:user.balance,
operations:user.operations,
packageName:user.packageName,
dailyIncome,
referralCode:user.referralCode,
referralCount:teamMembers.length

})

})

/* ايداع */
app.post("/deposit",(req,res)=>{

const email=normalizeEmail(req.body.email)
const amount=Number(req.body.amount)
const network=cleanText(req.body.network)
const txid=cleanText(req.body.txid)
const packageName=cleanText(req.body.packageName)
const dailyProfit=Number(req.body.dailyProfit||0)
const durationDays=Number(req.body.durationDays||0)

const user=users[email]

if(!user){
return res.json({success:false})
}

const op={
type:packageName?"package_deposit":"deposit",
packageName,
amount,
network,
txid,
dailyProfit,
durationDays,
status:"pending",
date:new Date().toISOString()
}

user.operations.unshift(op)

res.json({success:true})

})

/* موافقة الأدمن */
app.post("/approve-operation",(req,res)=>{

const email=req.body.email
const index=req.body.index

const user=users[email]

if(!user){
return res.json({success:false})
}

const op=user.operations[index]

if(!op){
return res.json({success:false})
}

op.status="approved"

if(op.type==="deposit"){
user.balance+=op.amount
}

if(op.type==="package_deposit"){

user.packageName=op.packageName
user.packagePrice=op.amount
user.dailyProfit=op.dailyProfit
user.packageStart=Date.now()
user.packageDurationDays=op.durationDays

}

res.json({success:true})

})

/* رفض العملية */
app.post("/reject-operation",(req,res)=>{

const email=req.body.email
const index=req.body.index

const user=users[email]

if(!user){
return res.json({success:false})
}

const op=user.operations[index]

if(!op){
return res.json({success:false})
}

op.status="rejected"

res.json({success:true})

})

/* سحب */
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

user.balance-=amount

user.operations.unshift({
type:"withdraw",
amount,
status:"pending",
date:new Date().toISOString()
})

res.json({success:true})

})

/* المستخدمين */
app.get("/users",(req,res)=>{
res.json({success:true,users})
})

const PORT=process.env.PORT||10000

app.listen(PORT,()=>{
console.log("Server running on port "+PORT)
})
