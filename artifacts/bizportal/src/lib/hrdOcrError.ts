/** Keep the uploaded private document; do not encourage repeated re-uploads on OCR provider errors. */
export function hrdScanFailureMessage(message: string): string {
  if (/HRD_OCR_PROVIDER_HTTP_429_(?:INSUFFICIENT_QUOTA|BILLING_HARD_LIMIT_REACHED|CREDIT_BALANCE_EXHAUSTED|ORGANIZATION_USAGE_LIMIT_EXCEEDED|ORGANIZATION_SPEND_LIMIT_EXCEEDED|PROJECT_SPEND_LIMIT_EXCEEDED)(?:$|[^A-Z0-9_])/.test(message)) {
    return "Kuota/kredit atau batas pengeluaran OpenAI API tercapai (HTTP 429). Dokumen tetap tersimpan privat. Jangan unggah ulang atau scan ulang dulu; periksa saldo kredit, batas penggunaan organisasi, dan batas pengeluaran proyek/organisasi.";
  }
  if (/HRD_OCR_PROVIDER_HTTP_429_(?:RATE_LIMIT_EXCEEDED|REQUESTS|TOKENS)(?:$|[^A-Z0-9_])/.test(message)) {
    return "Batas permintaan/token OpenAI API tercapai (HTTP 429). Dokumen tetap tersimpan privat. Jangan unggah ulang; tunggu sampai batas reset sebelum mencoba scan ulang dokumen yang sama.";
  }
  if (/HRD_OCR_PROVIDER_HTTP_429(?:$|[^A-Z0-9_])/.test(message)) {
    return "OpenAI API menolak scan dengan HTTP 429, tetapi jenis batas belum teridentifikasi. Dokumen tetap tersimpan privat. Jangan unggah ulang atau scan ulang sampai batas diperiksa.";
  }
  return message;
}
