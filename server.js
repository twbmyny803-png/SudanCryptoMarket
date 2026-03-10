const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

/* قاعدة بيانات مؤقتة */
let users = {};

/* تخزين الأكواد */
let codes = {};

/* ------------------------ */
/* إرسال كود تحقق */
/* ------------------------ */

app.post("/send-code",(req,res)=>{

const {email,purpose} = req.body;

if(!email){
return res.json({
success:false,
message:"البريد مطلوب"
});
}

const code = Math.floor(100000 + Math.random()*900000).toString();

codes[email] = code;

/* في مشروعنا الحالي سنرجع الكود فقط */
console.log("OTP Code:",code);

res.json({
success:true,
message:"تم إرسال الكود"
});

});

/* ------------------------ */
/* إنشاء حساب */
/* ------------------------ */

app.post("/register",(req,res)=>{

const {name,email,password} = req.body;

if(!name || !email || !password){
return res.json({
success:false,
message:"كل الحقول مطلوبة"
});
}

if(users[email]){
return res.json({
success:false,
message:"الحساب موجود مسبقاً"
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

/* ------------------------ */
/* تسجيل الدخول */
/* ------------------------ */

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

/* ------------------------ */
/* جلب بيانات المستخدم */
/* ------------------------ */

app.post("/user-data",(req,res)=>{

const {email} = req.body;

const user = users[email];

if(!user){
return res.json({
success:false,
message:"المستخدم غير موجود"
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

/* ------------------------ */
/* إضافة عملية */
/* ------------------------ */

app.post("/add-operation",(req,res)=>{

const {email,type,amount} = req.body;

const user = users[email];

if(!user){
return res.json({success:false});
}

user.operations.unshift({

type:type,
amount:amount,
time:new Date().toLocaleString()

});

if(type === "deposit"){
user.balance += amount;
}

if(type === "withdraw"){
user.balance -= amount;
}

res.json({success:true});

});

/* ------------------------ */
/* تشغيل السيرفر */
/* ------------------------ */

const PORT = process.env.PORT || 3000;

app.listen(PORT,()=>{
console.log("Server running on port",PORT);
});
