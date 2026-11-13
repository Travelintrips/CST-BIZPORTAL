import {describe,it,expect} from "vitest";
import {normalizeExtraction,validateReviewFields,validDocType,validMime,
 documentMimeMatches,MAX_DOCUMENT_BYTES,fieldsAllowedForDocument,hrdOcrReady,validateHrdSignedPreviewUrl,ocrProviderFailureCode,scanEmployeeDocument} from "./hrd-document-ocr";
import {parseLocalDocumentFields,localDocumentFieldsComplete} from "./hrd-document-ocr-local";
describe("HRD OCR provider diagnostics",()=>{
 it("reports only safe provider HTTP status codes",()=>{
  expect(ocrProviderFailureCode(401)).toBe("HRD_OCR_PROVIDER_HTTP_401");
  expect(ocrProviderFailureCode(429)).toBe("HRD_OCR_PROVIDER_HTTP_429");
  expect(ocrProviderFailureCode(429,"insufficient_quota"))
   .toBe("HRD_OCR_PROVIDER_HTTP_429_INSUFFICIENT_QUOTA");
  expect(ocrProviderFailureCode(429,"rate_limit_exceeded"))
   .toBe("HRD_OCR_PROVIDER_HTTP_429_RATE_LIMIT_EXCEEDED");
  expect(ocrProviderFailureCode(429,"rate_limit_exceeded","requests"))
   .toBe("HRD_OCR_PROVIDER_HTTP_429_RATE_LIMIT_EXCEEDED");
  expect(ocrProviderFailureCode(429,"credit_balance_exhausted","insufficient_quota"))
   .toBe("HRD_OCR_PROVIDER_HTTP_429_CREDIT_BALANCE_EXHAUSTED");
  expect(ocrProviderFailureCode(429,null,"requests"))
   .toBe("HRD_OCR_PROVIDER_HTTP_429_REQUESTS");
  expect(ocrProviderFailureCode(429,"unknown","insufficient_quota"))
   .toBe("HRD_OCR_PROVIDER_HTTP_429_INSUFFICIENT_QUOTA");
  expect(ocrProviderFailureCode(429,"organization_spend_limit_exceeded","insufficient_quota"))
   .toBe("HRD_OCR_PROVIDER_HTTP_429_ORGANIZATION_SPEND_LIMIT_EXCEEDED");
  expect(ocrProviderFailureCode(429,"untrusted-detail"))
   .toBe("HRD_OCR_PROVIDER_HTTP_429");
  expect(ocrProviderFailureCode(503)).toBe("HRD_OCR_PROVIDER_HTTP_503");
  expect(ocrProviderFailureCode(200)).toBe("HRD_OCR_PROVIDER_FAILED");
  expect(ocrProviderFailureCode(Number.NaN)).toBe("HRD_OCR_PROVIDER_FAILED");
 });
});
describe("Private HRD document OCR no-guess validation",()=>{
 it("keeps PROD OCR ready without an OpenAI key when local OCR is enabled",()=>{
  const keys=["APP_ENV","HRD_PROD_OCR_ENABLED","HRD_PROD_SUPABASE_URL",
   "HRD_PROD_STORAGE_SERVICE_KEY","HRD_PROD_OPENAI_API_KEY",
   "HRD_PROD_OCR_LOCAL_ENABLED","HRD_PROD_OCR_OPENAI_FALLBACK_ENABLED"];
  const snapshot=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  try{
   process.env.APP_ENV="production";
   process.env.HRD_PROD_OCR_ENABLED="true";
   process.env.HRD_PROD_SUPABASE_URL="https://nzdweipzckfszczzqtuw.supabase.co";
   process.env.HRD_PROD_STORAGE_SERVICE_KEY="test-only-key";
   process.env.HRD_PROD_OCR_LOCAL_ENABLED="true";
   process.env.HRD_PROD_OCR_OPENAI_FALLBACK_ENABLED="true";
   delete process.env.HRD_PROD_OPENAI_API_KEY;
   expect(hrdOcrReady()).toBe(true);
   process.env.HRD_PROD_OCR_LOCAL_ENABLED="false";
   expect(hrdOcrReady()).toBe(false);
   process.env.HRD_PROD_OPENAI_API_KEY="test-only-key";
   expect(hrdOcrReady()).toBe(true);
   process.env.HRD_PROD_OCR_OPENAI_FALLBACK_ENABLED="false";
   expect(hrdOcrReady()).toBe(false);
   process.env.HRD_PROD_SUPABASE_URL="https://wrong-project.supabase.co";
   expect(hrdOcrReady()).toBe(false);
   process.env.HRD_PROD_SUPABASE_URL="https://nzdweipzckfszczzqtuw.supabase.co";
   process.env.APP_ENV="development";
   expect(hrdOcrReady()).toBe(false);
  }finally{
   for(const [k,v] of Object.entries(snapshot)){
    if(v===undefined)delete process.env[k];else process.env[k]=v;
   }
  }
 });
 it("accepts known document and MIME types only",()=>{
  expect(validDocType("ktp")).toBe(true);
  expect(validDocType("kk")).toBe(true);
  expect(validDocType("passport")).toBe(false);
  expect(validMime("image/png")).toBe(true);
  expect(validMime("text/html")).toBe(false);
  expect(MAX_DOCUMENT_BYTES).toBe(5242880);
 });
 it("rejects implausible NIK/KK values without making up personal identifiers",()=>{
  const result=normalizeExtraction({
   nik:"not-a-nik",nomor_kk:"123",nama_lengkap:"  ALMANO SETIAWAN  ",
   tanggal_lahir:"unknown",alamat:""
  },0.86,["Low contrast"]);
  expect(result.fields.nik).toBeNull();
  expect(result.fields.nomor_kk).toBeNull();
  expect(result.fields.tanggal_lahir).toBeNull();
  expect(result.fields.nama_lengkap).toBe("ALMANO SETIAWAN");
  expect(result.confidence).toBe(0.86);
 });
 it("never accepts unexpected fields or malformed NIK at human approval",()=>{
  expect(()=>validateReviewFields({password:"123"})).toThrow("UNEXPECTED_REVIEW_FIELD");
  expect(()=>validateReviewFields({nik:"123"})).toThrow("NIK_MUST_BE_16_DIGITS");
  expect(()=>validateReviewFields({nomor_kk:"12"})).toThrow("KK_MUST_BE_16_DIGITS");
  expect(validateReviewFields({nik:"3174010101900001",alamat:" Test  "}))
   .toEqual({nik:"3174010101900001",alamat:"Test"});
 });
 it("preserves KK family rows for human review without permitting them on KTP",()=>{
  const rows=Array.from({length:15},(_,i)=>`PERSON ${i+1} | ANAK | 2010-01-01`).join("\n");
  const extracted=normalizeExtraction({anggota_keluarga:rows},0.73,[]);
  expect(extracted.fields.anggota_keluarga).toBe(rows);
  expect(validateReviewFields({anggota_keluarga:rows})).toEqual({anggota_keluarga:rows});
  expect(fieldsAllowedForDocument("kk",{anggota_keluarga:rows})).toEqual({anggota_keluarga:rows});
  expect(()=>fieldsAllowedForDocument("ktp",{anggota_keluarga:rows}))
   .toThrow("FIELD_NOT_ALLOWED_FOR_DOCUMENT");
  expect(()=>validateReviewFields({anggota_keluarga:"x".repeat(4001)}))
   .toThrow("REVIEW_VALUE_TOO_LONG");
 });
 it("rejects KTP attempting to change HRD employment or salary fields",()=>{
  expect(()=>fieldsAllowedForDocument("ktp",{jabatan:"CEO"}))
   .toThrow("FIELD_NOT_ALLOWED_FOR_DOCUMENT");
  expect(fieldsAllowedForDocument("sim",{jenis_sim:"A",masa_berlaku:"2027-01-01"}))
   .toEqual({jenis_sim:"A",masa_berlaku:"2027-01-01"});
  expect(()=>fieldsAllowedForDocument("foto",{nik:"3174010101900001"}))
   .toThrow("FIELD_NOT_ALLOWED_FOR_DOCUMENT");
 });
 it("builds a strictly scoped 60-second signed preview URL without redirecting to another object",()=>{
  const base="https://nzdweipzckfszczzqtuw.supabase.co";
  const path="1/26/11111111-1111-4111-8111-111111111111.jpg";
  const signed="/object/sign/bizportal-hrd-documents-prod/"+path+"?token=abc123";
  expect(validateHrdSignedPreviewUrl(base,path,signed)).toBe(
   base+"/storage/v1"+signed
  );
  expect(()=>validateHrdSignedPreviewUrl(base,path,"https://evil.test/object/sign/"+path+"?token=abc"))
   .toThrow("HRD_SIGNED_URL_INVALID");
  expect(()=>validateHrdSignedPreviewUrl(base,path,"/object/sign/bizportal-hrd-documents-prod/1/99/other.jpg?token=abc"))
   .toThrow("HRD_SIGNED_URL_INVALID");
  expect(()=>validateHrdSignedPreviewUrl(base,path,signed.replace("token=abc123","t=abc123")))
   .toThrow("HRD_SIGNED_URL_INVALID");
 });
 it("rejects unsupported document bytes, not only the request MIME header",()=>{
  expect(documentMimeMatches(Buffer.from("fake"),"application/pdf")).toBe(false);
  expect(documentMimeMatches(Buffer.from("%PDF-1.7"),"application/pdf")).toBe(true);
  expect(documentMimeMatches(Buffer.from("notpng"),"image/png")).toBe(false);
 });
});

describe("HRD local-first hybrid OCR",()=>{
 it("extracts SKCK fields locally and recognizes a complete local result",()=>{
  const text=["SURAT KETERANGAN CATATAN KEPOLISIAN","NAMA LENGKAP: BUDI SANTOSO",
   "NOMOR SKCK: SKCK/2026/12345","BERLAKU SAMPAI: 31-12-2026"].join("\n");
  const fields=parseLocalDocumentFields("skck",text);
  expect(fields.nama_lengkap).toBe("BUDI SANTOSO");
  expect(fields.nomor_dokumen).toBe("SKCK/2026/12345");
  expect(fields.masa_berlaku).toBe("2026-12-31");
  expect(localDocumentFieldsComplete("skck",fields)).toBe(true);
 });
 it("extracts KTP NIK and birth date without inventing missing values",()=>{
  const text=["NIK: 3174010101900001","Nama Lengkap: SITI AMINAH",
   "Tempat/Tgl Lahir: BANDUNG, 12-03-1992","Alamat: JALAN MELATI 10"].join("\n");
  const fields=parseLocalDocumentFields("ktp",text);
  expect(fields.nik).toBe("3174010101900001");
  expect(fields.nama_lengkap).toBe("SITI AMINAH");
  expect(fields.tempat_lahir).toBe("BANDUNG");
  expect(fields.tanggal_lahir).toBe("1992-03-12");
  expect(fields.alamat).toBe("JALAN MELATI 10");
  expect(fields.agama).toBeUndefined();
 });
 it("does not misclassify an unlabeled NIK as a SIM document number",()=>{
  const text=["NAMA: BUDI SANTOSO","3174010101900001","GOLONGAN SIM: C",
   "BERLAKU SAMPAI: 31-12-2028"].join("\n");
  const fields=parseLocalDocumentFields("sim",text);
  expect(fields.nomor_dokumen).toBeUndefined();
  expect(fields.jenis_sim).toBe("C");
  expect(fields.masa_berlaku).toBe("2028-12-31");
  expect(localDocumentFieldsComplete("sim",fields)).toBe(false);
 });
 it("does not misclassify a KTP NIK as an NPWP without an NPWP label",()=>{
  const text=["NAMA: BUDI SANTOSO","NIK: 3174010101900001","ALAMAT: JALAN MELATI 10"].join("\n");
  const fields=parseLocalDocumentFields("npwp",text);
  expect(fields.nomor_dokumen).toBeUndefined();
  expect(fields.nik).toBe("3174010101900001");
 });
 it("extracts SIM and NPWP numbers only from their labeled fields",()=>{
  const sim=parseLocalDocumentFields("sim",["NAMA: BUDI SANTOSO","NOMOR SIM: 123456789012",
   "GOLONGAN SIM: C","BERLAKU SAMPAI: 31-12-2028"].join("\n"));
  expect(sim.nomor_dokumen).toBe("123456789012");
  const npwp=parseLocalDocumentFields("npwp",["NAMA: BUDI SANTOSO",
   "NPWP: 12.345.678.9-012.000","NIK: 3174010101900001"].join("\n"));
  expect(npwp.nomor_dokumen).toBe("123456789012000");
  expect(npwp.nik).toBe("3174010101900001");
 });
 it("matches complete labels and does not let NAMA capture NAMA SEKOLAH",()=>{
  const text=["NAMA SEKOLAH: SMA NEGERI 1","NAMA: BUDI SANTOSO"].join("\n");
  const fields=parseLocalDocumentFields("ijazah",text);
  expect(fields.institusi).toBe("SMA NEGERI 1");
  expect(fields.nama_lengkap).toBe("BUDI SANTOSO");
 });
 it("does not treat a family member NIK as the KK document number",()=>{
  const text=["NAMA KEPALA KELUARGA: TEST KEPALA",
   "1 TEST ANGGOTA 1111111111111111 PEREMPUAN TEST 03-03-1995 ISTRI"].join("\n");
  const fields=parseLocalDocumentFields("kk",text);
  expect(fields.nomor_kk).toBeUndefined();
  expect(fields.anggota_keluarga).toBe("TEST ANGGOTA | ISTRI | 1995-03-03");
  expect(localDocumentFieldsComplete("kk",fields)).toBe(false);
 });
 it("preserves readable KK family relationships and leaves incomplete rows for fallback",()=>{
  const complete=["NOMOR KK: 3174010101900001",
   "1 BUDI SANTOSO 3174010101900001 LAKI-LAKI BANDUNG 02-02-1992 KEPALA KELUARGA"].join("\n");
  const fields=parseLocalDocumentFields("kk",complete);
  expect(fields.anggota_keluarga).toBe("BUDI SANTOSO | KEPALA KELUARGA | 1992-02-02");
  const incomplete=parseLocalDocumentFields("kk",
   "NOMOR KK: 3174010101900001\n1 BUDI SANTOSO 3174010101900001 LAKI-LAKI BANDUNG 02-02-1992");
  expect(incomplete.anggota_keluarga).toBeUndefined();
 });
 it("does not fill a missing field with the next field's label and value",()=>{
  const skck=parseLocalDocumentFields("skck",
   "NAMA LENGKAP:\nNOMOR SKCK: SKCK/2026/12345\nBERLAKU SAMPAI: 31-12-2026");
  expect(skck.nama_lengkap).toBeUndefined();
  expect(localDocumentFieldsComplete("skck",skck)).toBe(false);
  const ktp=parseLocalDocumentFields("ktp",
   "NIK: 1111111111111111\nNAMA: TEST ORANG\nTEMPAT/TGL LAHIR: TEST, 01-01-1990\nALAMAT:\nRT/RW: 001/002");
  expect(ktp.alamat).toBeUndefined();
  expect(ktp.rt_rw).toBe("001/002");
 });
 it("does not use a birth year as the graduation year",()=>{
  const text=["TANGGAL LAHIR: 12-03-1992","NAMA: BUDI SANTOSO",
   "NAMA SEKOLAH: SMA NEGERI 1","DINYATAKAN LULUS PADA TANGGAL 20 MEI 2010"].join("\n");
  const fields=parseLocalDocumentFields("ijazah",text);
  expect(fields.tahun_lulus).toBe("2010");
  const noGraduation=parseLocalDocumentFields("ijazah",
   "TANGGAL LAHIR: 12-03-1992\nNAMA: BUDI SANTOSO\nNAMA SEKOLAH: SMA NEGERI 1");
  expect(noGraduation.tahun_lulus).toBeUndefined();
 });
 it("does not read a birthplace keyword as the family relationship",()=>{
  const text=["NOMOR KK: 2222222222222222","NAMA KEPALA KELUARGA: TEST KEPALA",
   "1 TEST ANGGOTA 1111111111111111 PEREMPUAN ANAK TUHA 03-03-1995 ISTRI"].join("\n");
  const fields=parseLocalDocumentFields("kk",text);
  expect(fields.anggota_keluarga).toBe("TEST ANGGOTA | ISTRI | 1995-03-03");
 });
 it("marks the KK family list incomplete when any candidate row has OCR damage",()=>{
  const text=["NOMOR KK: 3174010101900001",
   "1 BUDI SANTOSO 3174010101900001 LAKI-LAKI BANDUNG 02-02-1992 KEPALA KELUARGA",
   "2 SITI AMINAH 3174010101900002 PEREMPU4AN JAKARTA 03-03-1995 ISTRI"].join("\n");
  const fields=parseLocalDocumentFields("kk",text);
  expect(fields.anggota_keluarga).toBeUndefined();
  expect(localDocumentFieldsComplete("kk",fields)).toBe(false);
 });
 it("uses local OCR without calling OpenAI when required fields are complete",async()=>{
  const snapshot={APP_ENV:process.env.APP_ENV,HRD_PROD_OCR_LOCAL_ENABLED:process.env.HRD_PROD_OCR_LOCAL_ENABLED,
   HRD_PROD_OPENAI_API_KEY:process.env.HRD_PROD_OPENAI_API_KEY,HRD_PROD_OCR_OPENAI_FALLBACK_ENABLED:process.env.HRD_PROD_OCR_OPENAI_FALLBACK_ENABLED};
  try{
   process.env.APP_ENV="production";process.env.HRD_PROD_OCR_LOCAL_ENABLED="true";
   process.env.HRD_PROD_OCR_OPENAI_FALLBACK_ENABLED="true";delete process.env.HRD_PROD_OPENAI_API_KEY;
   const result=await scanEmployeeDocument(Buffer.from("synthetic"),"image/png","skck",
    async()=>({text:"NAMA LENGKAP: BUDI SANTOSO\nNOMOR SKCK: SKCK/2026/12345\nBERLAKU SAMPAI: 31-12-2026",confidence:0.92,source:"tesseract",warnings:[]}),
    async()=>{throw Error("OPENAI_MUST_NOT_BE_CALLED")});
   expect(result.engine).toBe("local");
   expect(result.fields.nama_lengkap).toBe("BUDI SANTOSO");
   expect(result.warnings.join(" ")).toContain("tidak menggunakan kuota OpenAI");
  }finally{
   for(const [k,v] of Object.entries(snapshot)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  }
 });
 it("uses OpenAI only as fallback and sends both local text and the original image",async()=>{
  const snapshot={APP_ENV:process.env.APP_ENV,HRD_PROD_OCR_LOCAL_ENABLED:process.env.HRD_PROD_OCR_LOCAL_ENABLED,
   HRD_PROD_OPENAI_API_KEY:process.env.HRD_PROD_OPENAI_API_KEY,HRD_PROD_OCR_OPENAI_FALLBACK_ENABLED:process.env.HRD_PROD_OCR_OPENAI_FALLBACK_ENABLED};
  try{
   process.env.APP_ENV="production";process.env.HRD_PROD_OCR_LOCAL_ENABLED="true";
   process.env.HRD_PROD_OCR_OPENAI_FALLBACK_ENABLED="true";process.env.HRD_PROD_OPENAI_API_KEY="test-only-key";
   let sent:any;
   const fields={nik:null,nama_lengkap:"BUDI SANTOSO",tempat_lahir:null,tanggal_lahir:null,alamat:null,nomor_kk:null,
    nomor_dokumen:"SKCK/2026/12345",jenis_sim:null,masa_berlaku:"2026-12-31",institusi:null,jurusan:null,
    tahun_lulus:null,jabatan:null,tanggal_mulai_kontrak:null,tanggal_akhir_kontrak:null,jenis_kelamin:null,
    agama:null,status_perkawinan:null,rt_rw:null,kelurahan:null,kecamatan:null,anggota_keluarga:null};
   const result=await scanEmployeeDocument(Buffer.from("synthetic-image"),"image/png","skck",
    async()=>({text:"NAMA LENGKAP: BUDI SANTOSO",confidence:0.9,source:"tesseract",warnings:[]}),
    async(_url,init)=>{sent=JSON.parse(String(init?.body));return new Response(JSON.stringify({output_text:JSON.stringify({fields,confidence:0.9,warnings:[]})}),{status:200,headers:{"content-type":"application/json"}})});
   expect(result.engine).toBe("openai_fallback");
   const content=sent.input[0].content;
   expect(content.some((x:any)=>String(x.text??"").includes("NAMA LENGKAP: BUDI SANTOSO"))).toBe(true);
   expect(content.some((x:any)=>x.type==="input_image"&&String(x.image_url??"").startsWith("data:image/png;base64,"))).toBe(true);
  }finally{
   for(const [k,v] of Object.entries(snapshot)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  }
 });
 it("keeps the original PDF and partial local text as fallback context",async()=>{
  const snapshot={APP_ENV:process.env.APP_ENV,HRD_PROD_OCR_LOCAL_ENABLED:process.env.HRD_PROD_OCR_LOCAL_ENABLED,
   HRD_PROD_OPENAI_API_KEY:process.env.HRD_PROD_OPENAI_API_KEY,HRD_PROD_OCR_OPENAI_FALLBACK_ENABLED:process.env.HRD_PROD_OCR_OPENAI_FALLBACK_ENABLED};
  try{
   process.env.APP_ENV="production";process.env.HRD_PROD_OCR_LOCAL_ENABLED="true";
   process.env.HRD_PROD_OCR_OPENAI_FALLBACK_ENABLED="true";process.env.HRD_PROD_OPENAI_API_KEY="test-only-key";
   let sent:any;
   const result=await scanEmployeeDocument(Buffer.from("%PDF-1.7 synthetic document"),"application/pdf","skck",
    async()=>({text:"CONFIDENTIAL COMPANY WATERMARK AND INTERNAL DOCUMENT HEADER",confidence:0.98,source:"pdf_text",warnings:[]}),
    async(_url,init)=>{
     sent=JSON.parse(String(init?.body));
     return new Response(JSON.stringify({output_text:JSON.stringify({
      fields:{nama_lengkap:"BUDI SANTOSO",nomor_dokumen:"SKCK/2026/12345",masa_berlaku:"2026-12-31"},
      confidence:0.9,warnings:[]
     })}),{status:200,headers:{"content-type":"application/json"}});
    });
   expect(result.engine).toBe("openai_fallback");
   const content=sent.input[0].content;
   expect(content.some((x:any)=>x.type==="input_file"&&String(x.file_data??"").startsWith("data:application/pdf;base64,"))).toBe(true);
   expect(content.some((x:any)=>String(x.text??"").includes("CONFIDENTIAL COMPANY WATERMARK"))).toBe(true);
  }finally{
   for(const [k,v] of Object.entries(snapshot)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  }
 });
 it("keeps a document retryable when local OCR has no fields and OpenAI is rate limited",async()=>{
  const snapshot={APP_ENV:process.env.APP_ENV,HRD_PROD_OCR_LOCAL_ENABLED:process.env.HRD_PROD_OCR_LOCAL_ENABLED,
   HRD_PROD_OPENAI_API_KEY:process.env.HRD_PROD_OPENAI_API_KEY,HRD_PROD_OCR_OPENAI_FALLBACK_ENABLED:process.env.HRD_PROD_OCR_OPENAI_FALLBACK_ENABLED};
  try{
   process.env.APP_ENV="production";process.env.HRD_PROD_OCR_LOCAL_ENABLED="true";
   process.env.HRD_PROD_OCR_OPENAI_FALLBACK_ENABLED="true";process.env.HRD_PROD_OPENAI_API_KEY="test-only-key";
   await expect(scanEmployeeDocument(Buffer.from("%PDF-1.7 image-only"),"application/pdf","skck",
    async()=>({text:"",confidence:0,source:"unavailable",warnings:[]}),
    async()=>new Response(JSON.stringify({error:{code:"rate_limit_exceeded",type:"rate_limit_exceeded"}}),{status:429})
   )).rejects.toThrow("HRD_OCR_PROVIDER_HTTP_429_RATE_LIMIT_EXCEEDED");
  }finally{
   for(const [k,v] of Object.entries(snapshot)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  }
 });
 it("returns zero-confidence manual review only after OCR actually runs but recognizes no document fields",async()=>{
  const keys=["APP_ENV","HRD_PROD_OCR_LOCAL_ENABLED","HRD_PROD_OPENAI_API_KEY","HRD_PROD_OCR_OPENAI_FALLBACK_ENABLED"];
  const snapshot=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  try{
   process.env.APP_ENV="production";process.env.HRD_PROD_OCR_LOCAL_ENABLED="true";
   process.env.HRD_PROD_OCR_OPENAI_FALLBACK_ENABLED="false";delete process.env.HRD_PROD_OPENAI_API_KEY;
   const result=await scanEmployeeDocument(Buffer.from("synthetic"),"image/png","sim",
    async()=>({text:"SCREENSHOT WITHOUT READABLE SIM FIELDS",confidence:0.95,source:"tesseract",warnings:[]}),
    async()=>{throw Error("OPENAI_MUST_NOT_BE_CALLED")}
   );
   expect(result.engine).toBe("manual_review_required");
   expect(result.confidence).toBe(0);
   expect(Object.values(result.fields).every(value=>value===null)).toBe(true);
   expect(result.warnings.join(" ")).toContain("tidak ada field dokumen yang dikenali");
  }finally{
   for(const [k,v] of Object.entries(snapshot)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  }
 });
 it("does not mask an unavailable OCR engine as a successful scan",async()=>{
  const keys=["APP_ENV","HRD_PROD_OCR_LOCAL_ENABLED","HRD_PROD_OPENAI_API_KEY","HRD_PROD_OCR_OPENAI_FALLBACK_ENABLED"];
  const snapshot=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  try{
   process.env.APP_ENV="production";process.env.HRD_PROD_OCR_LOCAL_ENABLED="true";
   process.env.HRD_PROD_OCR_OPENAI_FALLBACK_ENABLED="false";delete process.env.HRD_PROD_OPENAI_API_KEY;
   await expect(scanEmployeeDocument(Buffer.from("synthetic"),"image/png","skck",
    async()=>({text:"",confidence:0,source:"unavailable",warnings:[]}),
    async()=>{throw Error("OPENAI_MUST_NOT_BE_CALLED")}
   )).rejects.toThrow("HRD_OCR_LOCAL_UNAVAILABLE");
  }finally{
   for(const [k,v] of Object.entries(snapshot)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  }
 });
 it("keeps local fields reviewable when the OpenAI fallback is rate limited",async()=>{
  const snapshot={APP_ENV:process.env.APP_ENV,HRD_PROD_OCR_LOCAL_ENABLED:process.env.HRD_PROD_OCR_LOCAL_ENABLED,
   HRD_PROD_OPENAI_API_KEY:process.env.HRD_PROD_OPENAI_API_KEY,HRD_PROD_OCR_OPENAI_FALLBACK_ENABLED:process.env.HRD_PROD_OCR_OPENAI_FALLBACK_ENABLED};
  try{
   process.env.APP_ENV="production";process.env.HRD_PROD_OCR_LOCAL_ENABLED="true";
   process.env.HRD_PROD_OCR_OPENAI_FALLBACK_ENABLED="true";process.env.HRD_PROD_OPENAI_API_KEY="test-only-key";
   const result=await scanEmployeeDocument(Buffer.from("synthetic"),"image/png","skck",
    async()=>({text:"NAMA LENGKAP: BUDI SANTOSO",confidence:0.8,source:"tesseract",warnings:[]}),
    async()=>new Response(JSON.stringify({error:{code:"insufficient_quota",type:"insufficient_quota"}}),{status:429}));
   expect(result.engine).toBe("openai_fallback_failed");
   expect(result.fields.nama_lengkap).toBe("BUDI SANTOSO");
   expect(result.warnings.join(" ")).toContain("HRD_OCR_PROVIDER_HTTP_429_INSUFFICIENT_QUOTA");
  }finally{
   for(const [k,v] of Object.entries(snapshot)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  }
 });
});
