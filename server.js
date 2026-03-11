const express = require("express");
const cors = require("cors");
const { Resend } = require("resend");

const app = express();

app.use(cors());
app.use(express.json());

const resend = new Resend(process.env.RESEND_API_KEY);

const otpStore = {};
const users = {};

const RATE_LIMIT_MS = 60 * 1000;
const OTP_EXPIRES_MS = 5 * 60 * 1000;
const PASSWORD_MIN_LENGTH = 8;

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
.toUpperCase()
.slice(0,3)

const part2=Math.floor(100+Math.random()*900).toString()

return part1+part2
}

app.get("/",(req,res)=>{
res.json({success:true,message:"Sudan Crypto API running"})
})

/* ارسال كود */
app.post("/send-code",async(req,res)=>{
try{

const email=normalizeEmail(req.body.email)
const purpose=cleanText(req.body.purpose||"register")
const now=Date.now()

if(!email){
return res.json({success:false,message:"البريد مطلوب"})
}

if(!isValidEmail(email)){
return res.json({success:false,message:"بريد غير صحيح"})
}

if(purpose==="register" && users[email]){
return res.json({success:false,message:"البريد مسجل"})
}

if((purpose==="login" || purpose==="reset") && !users[email]){
return res.json({success:false,message:"الحساب غير موجود"})
}

const code=generateOTP()

otpStore[email]={
code,
purpose,
expiresAt:now+OTP_EXPIRES_MS,
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
package:null,
packagePrice:0,
dailyPercent:0,
packageStart:null,
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

/* شراء باقة */
app.post("/buy-package",(req,res)=>{

const email=normalizeEmail(req.body.email)
const pack=cleanText(req.body.package)

const user=users[email]

if(!user){
return res.json({success:false})
}

let price=0
let percent=0

if(pack==="silver"){
price=100
percent=2
}

if(pack==="gold"){
price=500
percent=3
}

if(pack==="platinum"){
price=1000
percent=4
}

if(user.balance<price){
return res.json({success:false,message:"الرصيد غير كافي"})
}

user.balance-=price

user.package=pack
user.packagePrice=price
user.dailyPercent=percent
user.packageStart=Date.now()

res.json({success:true})

})

/* حساب الأرباح */
function calculateProfit(user){

if(!user.package){
return 0
}

const days=Math.floor((Date.now()-user.packageStart)/(1000*60*60*24))

return user.packagePrice*(user.dailyPercent/100)*days

}

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
email:user.email,
phone:user.phone,
balance:user.balance,
operations:user.operations,
package:user.package,
dailyIncome,
referralCode:user.referralCode,
referralCount:teamMembers.length

})

})

/* ايداع */
app.post("/deposit",(req,res)=>{

const email=normalizeEmail(req.body.email)
const amount=Number(req.body.amount)
const user=users[email]

if(!user){
return res.json({success:false})
}

const op={
type:"deposit",
amount,
status:"pending",
date:new Date().toISOString()
}

user.operations.unshift(op)

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

const op={
type:"withdraw",
amount,
status:"pending",
date:new Date().toISOString()
}

user.operations.unshift(op)

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
