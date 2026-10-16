import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FhirDownloadButton } from './FhirDownloadButton';
import { getFhirExport } from '../api';
vi.mock('../api',()=>({getFhirExport:vi.fn(),USE_MOCK:false}));
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();vi.clearAllMocks();});
function mount() {
  const client=new QueryClient({defaultOptions:{mutations:{retry:false}}});
  render(<QueryClientProvider client={client}><FhirDownloadButton sessionId="visit"/></QueryClientProvider>);
}
it('downloads the selected visit and releases the temporary URL',async()=>{
  vi.useFakeTimers();
  const create=vi.fn(()=> 'blob:synthetic');const revoke=vi.fn();
  vi.stubGlobal('URL',class extends URL {static createObjectURL=create;static revokeObjectURL=revoke;});
  vi.mocked(getFhirExport).mockResolvedValue(new Blob(['{"resourceType":"Bundle"}'],{type:'application/fhir+json'}));
  const click=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(function(this:HTMLAnchorElement){
    expect(this.download).toBe('qure-visit.fhir.json');expect(this.href).toBe('blob:synthetic');
  });
  mount();fireEvent.click(screen.getByRole('button',{name:'Unduh FHIR'}));
  await act(async()=>{await vi.advanceTimersByTimeAsync(50);});
  expect(getFhirExport).toHaveBeenCalledWith('visit');expect(click).toHaveBeenCalledTimes(1);expect(create).toHaveBeenCalledTimes(1);
  await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});expect(revoke).toHaveBeenCalledWith('blob:synthetic');
});
it('failed exports remain retryable and never trigger a download',async()=>{
  vi.useFakeTimers();vi.mocked(getFhirExport).mockRejectedValue(new Error('Ekspor FHIR belum tersedia. Coba lagi.'));
  const click=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});
  mount();fireEvent.click(screen.getByRole('button',{name:'Unduh FHIR'}));
  await act(async()=>{await vi.advanceTimersByTimeAsync(50);});
  expect(screen.getByRole('alert').textContent).toContain('Coba lagi');expect(click).not.toHaveBeenCalled();
  expect((screen.getByRole('button',{name:'Unduh FHIR'}) as HTMLButtonElement).disabled).toBe(false);
});
