const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

/* قاعدة بيانات مؤقتة */
let users = {};

/* تخزين الأكواد */
let codes = {};

/* ---------------------- */
/* إرسال كود تحقق */
/* ---------------------- */

app.post("/send-code",(req,res)=>{

const {email,purpose} = req.body;

if(!email){
return res.json({
success:false,
message:"البريد مطلوب"
});
}

/* لو تسجيل دخول نتأكد الحساب موجود */
if(purpose === "login"){
if(!users[email]){
return res.json({
success:false,
message:"البريد غير مسجل"
});
}
}

/* لو استرجاع كلمة السر */
if(purpose === "reset"){
if(!users[email]){
return res.json({
success:false,
message:"البريد غير مسجل"
});
}
}

/* إنشاء كود */
const code = Math.floor(100000 + Math.random()*900000).toString();

codes[email] = code;

/* يظهر في console فقط */
console.log("OTP for",email,":",code);

res.json({
success:true,
message:"تم إرسال الكود"
});

});


/* ---------------------- */
/* إنشاء حساب */
/* ---------------------- */

app.post("/register",(req,res)=>{

const {name,email,password} = req.body;

if(!name || !email || !password){
return res.json({
success:false,
message:"البيانات ناقصة"
});
}

if(users[email]){
return res.json({
success:false,
message:"الحساب مسجل مسبقاً"
});
}

users[email] = {

name:name,
email:email,
password:password,

balance:0,
dailyIncome:0,

operations:[]

};

res.json({
success:true,
message:"تم إنشاء الحساب"
});

});


/* ---------------------- */
/* تسجيل الدخول */
/* ---------------------- */

app.post("/login",(req,res)=>{

const {email,password} = req.body;

const user = users[email];

if(!user){
return res.json({
success:false,
message:"البريد غير مسجل"
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


/* ---------------------- */
/* استرجاع كلمة السر */
/* ---------------------- */

app.post("/reset-password",(req,res)=>{

const {email,password} = req.body;

const user = users[email];

if(!user){
return res.json({
success:false,
message:"الحساب غير موجود"
});
}

users[email].password = password;

res.json({
success:true,
message:"تم تغيير كلمة السر"
});

});


/* ---------------------- */
/* جلب بيانات المستخدم */
/* ---------------------- */

app.post("/user-data",(req,res)=>{

const {email} = req.body;

const user = users[email];

if(!user){
return res.json({
success:false
});
}

res.json({

success:true,

name:user.name,

balance:user.balance,

dailyIncome:user.dailyIncome,

operations:user.operations

});

});


/* ---------------------- */
/* تشغيل السيرفر */
/* ---------------------- */

const PORT = process.env.PORT || 3000;

app.listen(PORT,()=>{
console.log("Server running on port",PORT);
});
