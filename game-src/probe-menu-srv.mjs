import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const EDGE='C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT=Number(process.env.P||8812);
const prof=mkdtempSync(path.join(tmpdir(),'p-'));
const p=spawn(EDGE,['--headless=new','--remote-debugging-port=9971',`--user-data-dir=${prof}`,'--no-first-run','--no-default-browser-check','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--mute-audio','about:blank'],{stdio:'ignore'});
for(let i=0;i<40;i++){try{await fetch('http://127.0.0.1:9971/json/version');break}catch{await sleep(250)}}
const list=await(await fetch('http://127.0.0.1:9971/json/list')).json();
const page=list.find(t=>t.type==='page');
const ws=new WebSocket(page.webSocketDebuggerUrl);
const pend=new Map();let seq=0;
ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id)}});
await new Promise(r=>ws.addEventListener('open',r));
const send=(method,params={})=>new Promise(res=>{const id=++seq;pend.set(id,res);ws.send(JSON.stringify({id,method,params}))});
await send('Runtime.enable');await send('Page.enable');
const ev=async(expr)=>{const r=await send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true});return r.result?.result?.value};
await send('Page.navigate',{url:`http://127.0.0.1:${PORT}/index.html`});
for(let i=0;i<40;i++){if(await ev('!!document.getElementById("gxMenu")'))break;await sleep(250)}
console.log('menu appeared');
console.log('probe 直接跑:', await ev(`fetch('/api/home/state',{signal:AbortSignal.timeout(2000)}).then(async r=>JSON.stringify({ok:r.ok,ct:r.headers.get('content-type'),hasRoom:(await r.json()).room!==undefined})).catch(e=>'ERR '+e.message)`));
await sleep(3000);
console.log('选项:', await ev(`JSON.stringify([...document.querySelectorAll('#gxMenu .m-opt')].map(e=>e.className))`));
ws.close();p.kill();setTimeout(()=>{try{rmSync(prof,{recursive:true,force:true})}catch{};process.exit(0)},600);
