/** Operational follow-up only. Silence never counts as a medical assessment. */
export interface CheckInOptions {intervalMinutes:number;maxReminders:number;}
export const DEFAULT_CHECK_IN_OPTIONS:CheckInOptions={intervalMinutes:45,maxReminders:3};
export const CHECK_IN_POLL_MS=30_000;
export const CHECK_IN_WINDOW_MS=24*60*60*1000;
export const CHECK_IN_TEXT='Kami ingin mengecek keadaan Anda selama menunggu. Apakah keluhan Anda berubah atau memburuk? Balas dengan keadaan Anda saat ini. Ketik "petugas" untuk bantuan langsung.';
export const CHECK_IN_ACK_TEXT='Terima kasih sudah memberi kabar. Catatan Anda tetap dalam antrean. Beri tahu kami jika keluhan berubah atau memburuk.';
export const CHECK_IN_HANDOFF_TEXT='Pemeriksaan berkala otomatis dihentikan dan kunjungan Anda diteruskan ke antrean petugas untuk ditinjau. Waktu respons petugas belum dapat dipastikan. Jika keluhan berubah atau memburuk, balas pesan ini; bila darurat, hubungi 119 segera.';
/** A short status-only answer to a waiting-room check-in, never a safety verdict. */
export function isStatusOnlyCheckInReply(text:string):boolean {
  return /^(?:(?:saya|keadaan saya|kondisi saya)\s+)?(?:aman(?:\s+saja)?|baik(?:\s+saja)?|tidak ada perubahan|belum berubah|masih sama(?:\s+saja)?|sama saja|membaik|sudah membaik)[.!\s]*$/i.test(text.trim());
}
export function validateCheckInOptions(options:CheckInOptions):CheckInOptions {
  if(!Number.isFinite(options.intervalMinutes)||options.intervalMinutes<=0 || options.intervalMinutes>1440 || !Number.isSafeInteger(options.maxReminders)||options.maxReminders<1||options.maxReminders>10) throw new Error('Invalid check-in timing or limit');
  return options;
}
export function nextCheckInAt(now:Date,options:CheckInOptions=DEFAULT_CHECK_IN_OPTIONS):Date {
  return new Date(now.getTime()+options.intervalMinutes*60_000);
}
