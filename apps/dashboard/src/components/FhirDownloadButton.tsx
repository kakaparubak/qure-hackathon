import { useMutation } from '@tanstack/react-query';
import { getFhirExport, USE_MOCK } from '../api';
export function FhirDownloadButton({sessionId}:{sessionId:string}) {
  const download=useMutation({mutationFn:async()=>{
    const blob=await getFhirExport(sessionId);
    const url=URL.createObjectURL(blob);
    try {
      const link=document.createElement('a');link.href=url;link.download=`qure-${sessionId}.fhir.json`;
      document.body.appendChild(link);link.click();link.remove();
    } finally {setTimeout(()=>URL.revokeObjectURL(url),1000);}
  }});
  if(USE_MOCK) return null;
  return <div>
    <button onClick={()=>download.mutate()} disabled={download.isPending} className="min-h-11 rounded border border-line bg-white px-3 py-2 text-sm font-semibold text-ink hover:bg-slate-100 disabled:opacity-40">
      {download.isPending ? 'Menyiapkan ekspor…' : 'Unduh FHIR'}
    </button>
    {download.isError && <p role="alert" className="mt-1 text-sm font-semibold text-red-900">{download.error.message}</p>}
  </div>;
}
