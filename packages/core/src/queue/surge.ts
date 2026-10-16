/** Queue operations only: no medical advice is generated here. */
export const SURGE_P1_THRESHOLD = 3;
export const GREEN_LANE_COMMAND = 'JALUR HIJAU';
export const acceptsGreenLane = (text:string):boolean => /^jalur\s+hijau[.!?\s]*$/i.test(text.trim());

export interface QueueStatus {
  surgeActive:boolean;
  activeP1Count:number;
  threshold:number;
}
export function queueStatus(tiers:Array<string|null>):QueueStatus {
  const activeP1Count=tiers.filter(tier=>tier === 'P1').length;
  return {surgeActive:activeP1Count >= SURGE_P1_THRESHOLD,activeP1Count,threshold:SURGE_P1_THRESHOLD};
}
export function queueEtaText(minutes:number|null):string {
  return minutes === null ? 'Estimasi waktu belum tersedia.' : `Estimasi menunggu sekitar ${minutes} menit; dapat berubah jika ada kasus darurat baru.`;
}
export function surgeNotice(eta:number|null, offerGreen:boolean):string {
  return [
    'Antrean sedang sibuk karena beberapa kasus darurat perlu didahulukan.',
    queueEtaText(eta),
    'Jika keluhan berubah atau memburuk, balas pesan ini. Ketik "petugas" untuk meminta bantuan petugas.',
    ...(offerGreen ? [
      `Jika Anda bersedia menunggu panggilan balik dari petugas, balas "${GREEN_LANE_COMMAND}". Pilihan ini sukarela; tanpa persetujuan Anda tetap dalam antrean biasa.`,
      'Sambil menunggu, perhatikan perubahan keluhan dan tetap dapat dihubungi.',
    ] : []),
  ].join('\n');
}
export function callbackText(slot:Date):string {
  const time=slot.toLocaleString('id-ID',{timeZone:'Asia/Jakarta',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
  return `Anda memilih jalur panggilan balik. Jadwal panggilan balik: ${time} WIB. Petugas akan melihat jadwal ini di antrean. Tetap dapat dihubungi. Jika keluhan memburuk, balas pesan ini; ketik "petugas" jika membutuhkan bantuan langsung.`;
}
