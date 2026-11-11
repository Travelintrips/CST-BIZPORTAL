import {createRequire} from "node:module";
import {mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

const require=createRequire(import.meta.url);
const Tesseract=require("tesseract.js") as typeof import("tesseract.js");
const pdfParse=require("pdf-parse") as (
 bytes:Buffer,options?:{max?:number}
)=>Promise<{text?:string}>;
type Worker=Awaited<ReturnType<typeof Tesseract.createWorker>>;
export type LocalDocumentType="ktp"|"kk"|"sim"|"npwp"|"ijazah"|"skck"|"kontrak";
export type LocalOcrText={
 text:string;
 confidence:number;
 source:"tesseract"|"pdf_text"|"unavailable";
 warnings:string[];
};

let workerPromise:Promise<Worker>|null=null;
let imageQueue:Promise<void>=Promise.resolve();

async function getWorker():Promise<Worker>{
 if(!workerPromise){
  workerPromise=(async()=>{
   const home=process.env.HOME?.trim()||tmpdir();
   const cachePath=process.env.HRD_OCR_CACHE_PATH?.trim()||
    path.join(home,".cache","bizportal-hrd-ocr");
   await mkdir(cachePath,{recursive:true});
   const langPath=process.env.HRD_OCR_LANG_PATH?.trim()||
    "https://tessdata.projectnaptha.com/4.0.0";
   return Tesseract.createWorker("ind+eng",Tesseract.OEM.LSTM_ONLY,{
    langPath,cachePath,cacheMethod:"write",gzip:true,
    logger:()=>{},errorHandler:()=>{}
   });
  })().catch(error=>{
   workerPromise=null;
   throw error;
  });
 }
 return workerPromise;
}

export async function extractLocalOcrText(bytes:Buffer,mime:string):Promise<LocalOcrText>{
 if(mime==="application/pdf"){
  try{
   let parsed:{text?:string};
   try{parsed=await pdfParse(bytes,{max:8})}
   catch{parsed=await pdfParse(Buffer.from(bytes),{max:8})}
   const text=String(parsed.text??"").replace(/\f/g,"\n").trim();
   if(text.length>=24)return {
    text,confidence:0.98,source:"pdf_text",
    warnings:["Teks PDF dibaca langsung secara lokal."]
   };
   return {
    text,confidence:0,source:"pdf_text",
    warnings:["PDF berbasis gambar tidak memiliki lapisan teks; akan dicoba AI cadangan jika tersedia."]
   };
  }catch{
   return {
    text:"",confidence:0,source:"unavailable",
    warnings:["Pembacaan teks PDF lokal gagal; akan dicoba AI cadangan jika tersedia."]
   };
  }
 }
 if(!mime.startsWith("image/"))return {
  text:"",confidence:0,source:"unavailable",
  warnings:["Format belum didukung OCR lokal."]
 };
 const task=imageQueue.then(async()=>{
  const worker=await getWorker();
  const result=await worker.recognize(bytes,{rotateAuto:true});
  return {
   text:String(result.data.text??"").trim(),
   confidence:Math.max(0,Math.min(1,Number(result.data.confidence??0)/100)),
   source:"tesseract" as const,
   warnings:["Gambar dibaca menggunakan OCR lokal Tesseract."]
  };
 });
 imageQueue=task.then(()=>undefined,()=>undefined);
 try{
  return await task;
 }catch{
  return {
   text:"",confidence:0,source:"unavailable",
   warnings:["Mesin OCR lokal belum dapat dimuat; akan dicoba AI cadangan jika tersedia."]
  };
 }
}

function escapeRegex(value:string){
 return value.replace(/[.*+?^$()|[\]{}\\]/g,"\\$&");
}
function cleanValue(value:string|null|undefined):string|null{
 if(!value)return null;
 const cleaned=value.replace(/[|]+$/,"").replace(/\s{2,}/g," ").trim();
 if(!cleaned||/^(?:[-:;|]|N\/A)$/i.test(cleaned))return null;
 return cleaned.slice(0,320);
}
function findLabelValue(text:string,labels:string[]):string|null{
 const lines=text.replace(/\r/g,"\n").split("\n").map(line=>line.trim()).filter(Boolean);
 for(const label of labels){
  const pattern=new RegExp("^\\s*"+escapeRegex(label)+"(?=\\s*[:=\\-]|\\s{2,}|\\s*$)\\s*[:=\\-]?\\s*(.*)$","i");
  for(let index=0;index<lines.length;index++){
   const match=lines[index].match(pattern);
   if(!match)continue;
   let value=cleanValue(match[1]);
   const nextLine=lines[index+1];
   const nextLooksLikeAnotherLabel=Boolean(nextLine&&/^[A-Z][A-Z0-9 /().-]{1,}\s*[:=\-]\s*/i.test(nextLine));
   if(!value&&nextLine&&!nextLooksLikeAnotherLabel){
    value=cleanValue(nextLine);
   }
   if(value)return value;
  }
 }
 return null;
}
function digitsOnly(value:string|null|undefined,min=1,max=32):string|null{
 if(!value)return null;
 const digits=value.replace(/\D/g,"");
 return digits.length>=min&&digits.length<=max?digits:null;
}
function firstDigits(text:string,min:number,max:number):string|null{
 const groups=text.match(/(?:\d[\s.-]?){6,24}/g)??[];
 for(const group of groups){
  const digits=group.replace(/\D/g,"");
  if(digits.length>=min&&digits.length<=max)return digits;
 }
 return null;
}
function dateValue(value:string|null|undefined):string|null{
 if(!value)return null;
 const iso=value.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
 if(iso)return iso[1]+"-"+iso[2].padStart(2,"0")+"-"+iso[3].padStart(2,"0");
 const local=value.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/);
 if(local)return local[3]+"-"+local[2].padStart(2,"0")+"-"+local[1].padStart(2,"0");
 return null;
}
function yearValue(value:string|null|undefined):string|null{
 if(!value)return null;
 const match=value.match(/\b(?:19|20)\d{2}\b/);
 return match?.[0]??null;
}
function graduationYear(text:string):string|null{
 const lines=text.replace(/\r/g,"\n").split("\n");
 for(let index=0;index<lines.length;index++){
  const line=lines[index];
  const marker=line.match(/\b(?:LULUS|KELULUSAN|GRADUATION|GRADUATED)\b/i);
  if(!marker||marker.index===undefined)continue;
  const after=line.slice(marker.index+marker[0].length);
  const year=yearValue(after)??yearValue(lines[index+1]);
  if(year)return year;
 }
 return null;
}
function nameValue(text:string):string|null{
 return findLabelValue(text,["NAMA LENGKAP","NAMA KEPALA KELUARGA","KEPALA KELUARGA","NAMA"]);
}
function birthParts(text:string){
 const value=findLabelValue(text,["TEMPAT/TANGGAL LAHIR","TEMPAT/TGL LAHIR","TEMPAT LAHIR"]);
 if(!value)return {place:null,date:null};
 const date=dateValue(value);
 const place=cleanValue(date?value.replace(/\b\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}\b/,"").trim().replace(/[,;:-]+$/,""):value);
 return {place,date};
}
function familyRows(text:string):string|null{
 const lines=text.replace(/\r/g,"\n").split("\n").map(x=>x.trim()).filter(Boolean);
 const candidates=lines.filter(line=>
  /^\d{1,2}[.)]?\s+[A-Z][A-Z .'-]{2,}\s+/i.test(line) &&
  (/\d{12,}/.test(line)||/\b(?:LAKI-LAKI|PEREMPUAN|PEREMPU4AN|LAKI-LAK1|PRIA|WANITA)\b/i.test(line))
 );
 if(candidates.length===0||candidates.length>30)return null;
 const rows:string[]=[];
 for(const line of candidates){
  const match=line.match(/^\d{1,2}[.)]?\s+([A-Z][A-Z .'-]{2,})\s+(\d{16})\s+(LAKI-LAKI|PEREMPUAN)\s+(.+)$/i);
  // Any candidate row that cannot be parsed makes the whole local family list incomplete.
  if(!match)return null;
  const dateMatch=match[4].match(/\b(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4})\b/);
  const date=dateValue(match[4]);
  const afterBirthDate=dateMatch
   ?match[4].slice(dateMatch.index!+dateMatch[0].length):"";
  const relationship=afterBirthDate.match(/\b(KEPALA KELUARGA|ISTRI|SUAMI|ANAK|MENANTU|CUCU|ORANG TUA|MERTUA|FAMILI LAIN|LAINNYA)\b/i);
  if(!dateMatch||!date||!relationship)return null;
  rows.push([cleanValue(match[1]),cleanValue(relationship[1]),date].map(x=>x??"-").join(" | "));
 }
 return rows.length===candidates.length?rows.join("\n"):null;
}

export function parseLocalDocumentFields(docType:LocalDocumentType,text:string):Record<string,string|null>{
 const fields:Record<string,string|null>={};
 const name=nameValue(text);
 if(name)fields.nama_lengkap=name;
 switch(docType){
  case "ktp":{
   const nik=digitsOnly(findLabelValue(text,["NIK","NOMOR INDUK KEPENDUDUKAN"]),16,16)??firstDigits(text,16,16);
   const birth=birthParts(text);
   if(nik)fields.nik=nik;
   if(birth.place)fields.tempat_lahir=birth.place;
   if(birth.date)fields.tanggal_lahir=birth.date;
   const address=findLabelValue(text,["ALAMAT"]);
   if(address)fields.alamat=address;
   const gender=findLabelValue(text,["JENIS KELAMIN"]);
   if(gender)fields.jenis_kelamin=gender;
   const religion=findLabelValue(text,["AGAMA"]);
   if(religion)fields.agama=religion;
   const marital=findLabelValue(text,["STATUS PERKAWINAN"]);
   if(marital)fields.status_perkawinan=marital;
   const rtRw=findLabelValue(text,["RT/RW","RT RW"]);
   if(rtRw)fields.rt_rw=rtRw;
   const kel=findLabelValue(text,["KEL/DESA","KELURAHAN","DESA"]);
   if(kel)fields.kelurahan=kel;
   const kec=findLabelValue(text,["KECAMATAN"]);
   if(kec)fields.kecamatan=kec;
   break;
  }
  case "kk":{
   // A 16-digit family-member NIK is not evidence of the document's KK number.
   const kk=digitsOnly(findLabelValue(text,["NOMOR KK","NO. KK","NO KK","NOMOR KARTU KELUARGA"]),16,16);
   if(kk)fields.nomor_kk=kk;
   const family=familyRows(text);
   if(family)fields.anggota_keluarga=family;
   const address=findLabelValue(text,["ALAMAT"]);
   if(address)fields.alamat=address;
   if(!fields.nama_lengkap){
    const firstMember=(text.match(/^\s*1\s+([A-Z][A-Z .'-]{2,})/im)??[])[1];
    if(firstMember)fields.nama_lengkap=cleanValue(firstMember);
   }
   break;
  }
  case "sim":{
   const number=findLabelValue(text,["NOMOR SIM","NO. SIM","NO SIM","NOMOR"]);
   const digits=digitsOnly(number,8,24);
   if(digits)fields.nomor_dokumen=digits;
   const type=findLabelValue(text,["GOLONGAN SIM","JENIS SIM","GOL"]);
   if(type)fields.jenis_sim=type;
   const expiry=findLabelValue(text,["BERLAKU SAMPAI","MASA BERLAKU","BERLAKU S/D","VALID THRU"]);
   const date=dateValue(expiry);
   if(date)fields.masa_berlaku=date;
   break;
  }
  case "npwp":{
   const number=findLabelValue(text,["NPWP","NOMOR POKOK WAJIB PAJAK","NIK/NPWP"]);
   const digits=digitsOnly(number,15,16);
   if(digits)fields.nomor_dokumen=digits;
   const nik=digitsOnly(findLabelValue(text,["NIK"]),16,16);
   if(nik)fields.nik=nik;
   const address=findLabelValue(text,["ALAMAT"]);
   if(address)fields.alamat=address;
   break;
  }
  case "ijazah":{
   const number=findLabelValue(text,["NOMOR IJAZAH","NO. IJAZAH","NO IJAZAH","NOMOR SERTIFIKAT"]);
   if(number)fields.nomor_dokumen=number;
   const institution=findLabelValue(text,["NAMA SEKOLAH","NAMA PERGURUAN TINGGI","INSTITUSI","SEKOLAH/UNIVERSITAS"]);
   if(institution)fields.institusi=institution;
   const major=findLabelValue(text,["PROGRAM STUDI","JURUSAN"]);
   if(major)fields.jurusan=major;
   const year=graduationYear(text);
   if(year)fields.tahun_lulus=year;
   break;
  }
  case "skck":{
   const number=findLabelValue(text,["NOMOR SKCK","NO. SKCK","NO SKCK","NOMOR SURAT","NO. SURAT","NOMOR"]);
   if(number)fields.nomor_dokumen=number;
   const expiry=findLabelValue(text,["BERLAKU SAMPAI","BERLAKU S/D","MASA BERLAKU","SAMPAI DENGAN TANGGAL"]);
   const date=dateValue(expiry);
   if(date)fields.masa_berlaku=date;
   break;
  }
  case "kontrak":{
   const position=findLabelValue(text,["JABATAN","POSISI"]);
   if(position)fields.jabatan=position;
   const start=findLabelValue(text,["TANGGAL MULAI","MULAI BEKERJA","TERHITUNG MULAI"]);
   const startDate=dateValue(start);
   if(startDate)fields.tanggal_mulai_kontrak=startDate;
   const end=findLabelValue(text,["TANGGAL BERAKHIR","AKHIR KONTRAK","BERAKHIR PADA"]);
   const endDate=dateValue(end);
   if(endDate)fields.tanggal_akhir_kontrak=endDate;
   break;
  }
 }
 return fields;
}

const requiredLocalFields:Record<LocalDocumentType,string[]> = {
 ktp:["nik","nama_lengkap","tanggal_lahir","alamat"],
 kk:["nomor_kk","nama_lengkap","anggota_keluarga"],
 sim:["nomor_dokumen","nama_lengkap","jenis_sim","masa_berlaku"],
 npwp:["nomor_dokumen","nama_lengkap"],
 ijazah:["nama_lengkap","institusi"],
 skck:["nama_lengkap","nomor_dokumen","masa_berlaku"],
 kontrak:["nama_lengkap","jabatan","tanggal_mulai_kontrak"]
};
export function localDocumentFieldCoverage(docType:LocalDocumentType,fields:Record<string,string|null>){
 const required=requiredLocalFields[docType];
 return required.filter(key=>Boolean(fields[key]?.trim())).length/required.length;
}
export function localDocumentFieldsComplete(docType:LocalDocumentType,fields:Record<string,string|null>){
 return localDocumentFieldCoverage(docType,fields)===1;
}
