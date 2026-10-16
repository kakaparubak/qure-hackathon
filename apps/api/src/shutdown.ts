interface ShutdownApp {close():Promise<void>;log:{info(message:string):void;error(message:string):void};}
export interface SignalHost {
  once(event:'SIGTERM'|'SIGINT',listener:()=>void):unknown;
  removeListener(event:'SIGTERM'|'SIGINT',listener:()=>void):unknown;
  exit(code:number):unknown;
}
/** Docker stop sends SIGTERM. Drain requests/workers/channel/DB before exiting. */
export function installShutdown(app:ShutdownApp,host:SignalHost) {
  let stopping=false;
  const stop=()=>{
    if(stopping)return;stopping=true;
    app.log.info('Shutting down.');
    void app.close().then(()=>host.exit(0),()=>{app.log.error('Shutdown failed.');host.exit(1);});
  };
  host.once('SIGTERM',stop);host.once('SIGINT',stop);
  return ()=>{host.removeListener('SIGTERM',stop);host.removeListener('SIGINT',stop);};
}
