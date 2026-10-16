import {test,expect} from 'bun:test';
import {fileURLToPath} from 'node:url';
test('container probe exits successfully only for ready HTTP status and never prints bodies',async()=>{
  for(const status of [200,503]) {
    const server=Bun.serve({port:0,hostname:'127.0.0.1',fetch:()=>new Response('private response',{status})});
    try {
      const probe=Bun.spawn([process.execPath,'--no-env-file',fileURLToPath(new URL('../../../scripts/healthcheck.ts',import.meta.url))],
        {env:{PORT:String(server.port)},stdout:'pipe',stderr:'pipe'});
      expect(await probe.exited).toBe(status===200?0:1);
      expect(await new Response(probe.stdout).text()).toBe('');expect(await new Response(probe.stderr).text()).toBe('');
    } finally {await server.stop(true);}
  }
});
