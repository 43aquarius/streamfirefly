import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';

const source=fs.readFileSync(new URL('../extension/content.js',import.meta.url),'utf8');
function fixture(elements=[],frame=null){
 const probes=[],forwarded=[],listeners={},documentListeners={},timers=[];
 const context={crypto:{randomUUID:()=> 'document-fixture'},location:{href:'https://page.example/watch'},performance:{getEntriesByType:()=>[]},document:{documentElement:{},querySelector:()=>null,querySelectorAll:selector=>selector==='video'?elements.filter(element=>element.tagName==='VIDEO'):elements,addEventListener:(type,fn)=>{documentListeners[type]=fn;}},MutationObserver:class{observe(){}disconnect(){}},console,innerWidth:1280,innerHeight:800,setTimeout:fn=>timers.push(fn),clearTimeout:id=>{if(id)timers[id-1]=()=>{};}};
 context.window=context;context.top=frame?{}:context;if(frame)context.IntersectionObserver=class{constructor(callback){this.callback=callback;}observe(){this.callback([{intersectionRatio:frame.ratio}]);}disconnect(){}};context.addEventListener=(type,fn)=>{listeners[type]=fn;if(type==='message')context.deliverFixtureMessage=fn;};
 context.chrome={runtime:{onMessage:{addListener:fn=>{listeners.runtime=fn;}},sendMessage:message=>{
  if(message.type==='probe.install')return new Promise(resolve=>probes.push(resolve));
  forwarded.push(message);return Promise.resolve({ok:true});
 }}};
 vm.runInNewContext(source,context);
 return {probes,forwarded,documentListeners,timers,control:active=>listeners.runtime({type:'media.sniffing.control',active},{},()=>{}),emit:()=>vm.runInNewContext(`deliverFixtureMessage({source:window,data:{source:'streamfirefly',type:'media',candidate:{url:'https://cdn.example/inline.m3u8',source:'inline-script'}}});`,context)};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('a concurrent enable retains inline media emitted during initial probe installation',async()=>{
 const f=fixture();f.emit();f.control(true);
 assert.equal(f.probes.length,2);f.probes[0]({ok:true,active:true});await settle();
 assert.equal(f.forwarded.length,0,'superseded activation must not flush before the current probe completes');
 f.probes[1]({ok:true,active:true});await settle();
 assert.equal(f.forwarded.length,1);assert.equal(f.forwarded[0].candidate.source,'inline-script');
});
test('disabling discards buffered media and prevents a late probe response from activating sniffing',async()=>{
 const f=fixture();f.emit();f.control(false);f.probes[0]({ok:true,active:true});await settle();f.emit();
 assert.equal(f.forwarded.length,0);
});
test('a failed current installation discards its buffered media',async()=>{
 const f=fixture();f.emit();f.probes[0]({ok:false,active:false});await settle();f.emit();assert.equal(f.forwarded.length,0);
});
const video=(extra={})=>({tagName:'VIDEO',getAttribute:()=>null,addEventListener(){},ended:false,currentSrc:'blob:https://page.example/current',poster:'https://page.example/current.jpg',duration:30,paused:false,getBoundingClientRect:()=>({left:0,top:0,right:640,bottom:360,width:640,height:360}),...extra});
const play=(f,element)=>{f.documentListeners.playing({target:element});for(const run of f.timers.splice(0))run();};
test('a video that keeps playing mostly on screen becomes the page focus once',async()=>{
 const f=fixture();f.probes[0]({ok:true,active:true});await settle();
 const current=video();play(f,current);
 const focus=f.forwarded.filter(message=>message.type==='media.focus');
 assert.equal(focus.length,1);assert.deepEqual({...focus[0].focus},{url:'blob:https://page.example/current',poster:'https://page.example/current.jpg',duration:30});
 play(f,current);assert.equal(f.forwarded.filter(message=>message.type==='media.focus').length,1,'the same video must not be reported again');
});
test('off-screen, tiny or already paused videos do not take the page focus',async()=>{
 const f=fixture();f.probes[0]({ok:true,active:true});await settle();
 play(f,video({currentSrc:'blob:https://page.example/below',getBoundingClientRect:()=>({left:0,top:900,right:640,bottom:1260,width:640,height:360})}));
 play(f,video({currentSrc:'blob:https://page.example/icon',getBoundingClientRect:()=>({left:0,top:0,right:80,bottom:45,width:80,height:45})}));
 play(f,video({currentSrc:'blob:https://page.example/paused',paused:true}));
 assert.equal(f.forwarded.filter(message=>message.type==='media.focus').length,0);
});
test('a video already playing when sniffing starts becomes the focus immediately',async()=>{
 const small=video({currentSrc:'blob:https://page.example/small',getBoundingClientRect:()=>({left:0,top:0,right:320,bottom:180,width:320,height:180})});
 const large=video({currentSrc:'blob:https://page.example/large'});
 const paused=video({currentSrc:'blob:https://page.example/paused',paused:true,getBoundingClientRect:()=>({left:0,top:0,right:1280,bottom:720,width:1280,height:720})});
 const f=fixture([small,paused,large]);f.probes[0]({ok:true,active:true});await settle();
 const focus=f.forwarded.filter(message=>message.type==='media.focus');
 assert.equal(focus.length,1);assert.equal(focus[0].focus.url,'blob:https://page.example/large');
});
test('an off-screen player starting does not cancel a visible one that is settling',async()=>{
 const f=fixture();f.probes[0]({ok:true,active:true});await settle();
 f.documentListeners.playing({target:video()});
 f.documentListeners.playing({target:video({currentSrc:'blob:https://page.example/below',getBoundingClientRect:()=>({left:0,top:900,right:640,bottom:1260,width:640,height:360})})});
 for(const run of f.timers.splice(0))run();
 const focus=f.forwarded.filter(message=>message.type==='media.focus');
 assert.equal(focus.length,1);assert.equal(focus[0].focus.url,'blob:https://page.example/current');
});
test('inside a frame only a video visible on the top-level page takes the focus',async()=>{
 for(const [ratio,expected] of [[0,0],[0.3,0],[0.8,1]]){
  const f=fixture([],{ratio});f.probes[0]({ok:true,active:true});await settle();
  play(f,video());
  assert.equal(f.forwarded.filter(message=>message.type==='media.focus').length,expected,`frame visibility ${ratio}`);
 }
});
