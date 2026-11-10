# Payroll PROD — Komponen Gaji Standalone

Cakupan hanya gaji pokok, total tunjangan (termasuk uang makan), kasbon manual,
BPJS JHT, BPJS Kesehatan, PPh21, potongan lainnya, dan gaji bersih.

## Gerbang rilis
1. Backup/snapshot PROD dan catat jumlah `payroll_runs`/`payroll_items`; jangan mengubah historis.
2. CI Release Gate PASS: API, UI, typecheck, build, runtime smoke.
3. Jalankan migrasi tambah-dua-tabel `supabase/migrations/20261110131000_payroll_standalone_components_prod.sql`
   menggunakan operator SQL berwenang. Periksa RLS, grants, indeks, foreign key; kedua tabel baru awalnya kosong.
4. Deploy kode PROD setelah migrasi aman; biarkan `PAYROLL_PROD_COMPONENTS_ENABLED` tidak disetel (OFF).
5. Verifikasi `/api/health/live`, halaman Payroll lama, serta 21 item historis tetap utuh.
6. Aktifkan flag `PAYROLL_PROD_COMPONENTS_ENABLED=true` **hanya setelah** otorisasi Owner/Super Admin,
   penolakan admin/finance, readback konfigurasi kosong, dan migrasi diverifikasi.
7. Uji angka simulasi pada lingkungan isolasi **DEV**, bukan memasukkan nominal sintetis pada karyawan PROD.
8. Jangan mengaktifkan transaksi/approval/jurnal/payroll_items atau integrasi kasbon.
   Kasbon manual hanya memotong gaji dan **tidak** melunasi catatan kasbon.
9. Jika anomali, nonaktifkan flag terlebih dahulu. Jangan rollback destruktif/menghapus tabel berisi data.

## Fakta dan pembatasan
- Pada awal audit, PROD hanya mempunyai satu run Juni 2026 berstatus approved dan 21 item lama.
- PROD belum mempunyai `public.payroll_salary_profiles` dan `public.payroll_deduction_settings`.
- API menolak request saat flag belum aktif (GET 404, PUT 501).
- Setiap operasi memakai konteks perusahaan dari autentikasi server; tidak menerima identitas perusahaan dari body.
- Semua query konfigurasi menggunakan transaksi dan `set_config('app.payroll_company_id', ..., true)`.
- Nilai uang disimpan sebagai string dua desimal dan dihitung dengan `bigint`, bukan float.
- Input potongan kasbon >0 membutuhkan catatan sumber, 7 nominal harus eksplisit,
  potongan melebihi gaji kotor ditolak, dan status pembayaran tidak diubah.

## Pembuktian di PROD setelah aktivasi
Hanya uji baca + cek flag/capability tanpa menulis gaji karyawan nyata.
Penyimpanan PROD dilakukan kelak dengan nominal yang disahkan HR.
