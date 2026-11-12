/* Second Look — capture any window, mark what's wrong, get a numbered review.
   Everything runs in the browser. Nothing is uploaded anywhere. */
'use strict';

const $ = id => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const VENDOR = new URL('vendor/', location.href).href;
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const FS = 'showDirectoryPicker' in window;                      // Chrome / Edge only
const CAN_SHARE = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
const MARK = '#d93a2b';

let D = blankDoc();
let tool = 'box', stream = null;
const undoStack = [];            // [{secId, shapeId}]

function blankDoc(){ return {title:'', created:new Date().toISOString(), sections:[]}; }
const uid = () => Math.random().toString(36).slice(2,10);
const scripts = new Map();
function loadScript(src){
  if(!scripts.has(src)) scripts.set(src, new Promise((res,rej)=>{ const s=document.createElement('script'); s.src=src; s.onload=res; s.onerror=()=>rej(new Error('Could not load '+src)); document.head.appendChild(s); }));
  return scripts.get(src);
}

/* ---------- layout: phone screens sit beside their notes, slides and documents sit above them ---------- */
const DISP = {tall:300, square:340, wide:688};                   // on-page image width in px
function layoutOf(s){ const r=s.w/s.h; return r<0.75 ? 'tall' : r>1.25 ? 'wide' : 'square'; }
const U = s => 11/DISP[layoutOf(s)];                             // marker badge radius, in image-width units

/* ---------- storage ----------
   A saved review is a folder: review.json (text + mark-up), shots/ (screenshots), clips/ (videos), plus exports.
   IndexedDB holds a working copy so a refresh never loses anything. */
let db=null, dir=null, dirOK=false, saveTimer=null, io=Promise.resolve();
let RID=uid();                                                   // id of the open review in this browser's library
const blobs = new Map(), urls = new Map();                       // asset id -> Blob / object URL

function openDB(){ return new Promise(res=>{ try{
  const r=indexedDB.open('second-look',2);
  r.onupgradeneeded=()=>{ const d=r.result; for(const st of ['kv','blobs','reviews']) if(!d.objectStoreNames.contains(st)) d.createObjectStore(st); };
  r.onsuccess=()=>res(r.result); r.onerror=()=>res(null);
}catch(e){ res(null); } }); }
function idbPut(k,v,store='kv'){ try{ if(db) db.transaction(store,'readwrite').objectStore(store).put(v,k); }catch(e){} }
function idbGet(k,store='kv'){ return new Promise(res=>{ try{ if(!db) return res(null); const r=db.transaction(store).objectStore(store).get(k); r.onsuccess=()=>res(r.result||null); r.onerror=()=>res(null); }catch(e){ res(null); } }); }
function idbDel(k,store='kv'){ try{ if(db) db.transaction(store,'readwrite').objectStore(store).delete(k); }catch(e){} }
function idbAll(store){ return new Promise(res=>{ try{ if(!db) return res([]); const r=db.transaction(store).objectStore(store).getAll(); r.onsuccess=()=>res(r.result||[]); r.onerror=()=>res([]); }catch(e){ res([]); } }); }

const connected = () => !!(dir && dirOK);
function setDir(h){ dir=h; dirOK=!!h; }
async function writeFile(name, data, sub){
  const d = sub ? await dir.getDirectoryHandle(sub,{create:true}) : dir;
  const w = await (await d.getFileHandle(name,{create:true})).createWritable(); await w.write(data); await w.close();
}
function keepBlob(a, blob){ blobs.set(a.id, blob); idbPut(a.id, blob, 'blobs'); }
async function getBlob(a, sub, ask){
  if(!a) return null;
  if(blobs.has(a.id)) return blobs.get(a.id);
  let b = await idbGet(a.id,'blobs');
  if(!b && dir){
    try{
      if(!dirOK && ask) dirOK = (await dir.requestPermission({mode:'readwrite'}))==='granted';
      if(dirOK) b = await (await (await dir.getDirectoryHandle(sub)).getFileHandle(a.file)).getFile();
    }catch(e){}
  }
  if(b) blobs.set(a.id,b);
  return b||null;
}
function urlOf(a){
  if(!a || !blobs.has(a.id)) return null;
  if(!urls.has(a.id)) urls.set(a.id, URL.createObjectURL(blobs.get(a.id)));
  return urls.get(a.id);
}
async function dropAsset(a, sub){
  if(!a) return;
  if(urls.has(a.id)){ URL.revokeObjectURL(urls.get(a.id)); urls.delete(a.id); }
  blobs.delete(a.id); idbDel(a.id,'blobs');
  if(connected() && a.saved) try{ await (await dir.getDirectoryHandle(sub)).removeEntry(a.file); }catch(e){}
}
function resetAssets(){ urls.forEach(u=>URL.revokeObjectURL(u)); urls.clear(); blobs.clear(); }   // memory only; the library keeps each review's images
const hydrate = () => Promise.all(D.sections.map(s=>getBlob(s.shot,'shots')));

const serialize = () => JSON.stringify({app:'second-look', version:3, doc:D});
function save(){ clearTimeout(saveTimer); saveTimer=setTimeout(()=>{ io = io.then(persist).catch(e=>console.warn(e)); }, 500); }
async function persist(){
  if(connected()){
    try{ await flushAssets(); await writeFile('review.json', serialize()); }
    catch(e){ console.warn(e); dirOK=false; }
  }
  // every review lives in this browser's library until it is removed; an untouched blank one is not kept
  if(D.sections.length || D.title){ idbPut(RID, {id:RID, doc:D, handle:dir, updated:Date.now()}, 'reviews'); idbPut('currentId', RID); }
  else idbDel(RID,'reviews');
  showSaveState();
}
function flushNow(){ clearTimeout(saveTimer); io = io.then(persist).catch(e=>console.warn(e)); return io; }
document.addEventListener('visibilitychange', ()=>{ if(document.hidden) flushNow(); });
async function flushAssets(){
  for(const s of D.sections) for(const [a,sub] of [[s.shot,'shots'],[s.clip,'clips']]){
    if(!a || a.saved) continue;
    const b = await getBlob(a,sub); if(!b) continue;
    await writeFile(a.file, b, sub); a.saved=true;
    if(sub==='clips') idbDel(a.id,'blobs');                      // videos are big: once on disk, don't keep a second copy
  }
}
function showSaveState(){
  const st=$('status');
  if(connected()) st.innerHTML = `Saving to <b>${esc(dir.name)}</b>`;
  else if(dir) st.innerHTML = `<button id="btnReconnect">Keep saving to “${esc(dir.name)}”</button>`;
  else if(!D.sections.length) st.textContent = '';
  else st.innerHTML = FS ? 'Kept in this browser. Use <b>Save as…</b> to keep it as files.' : 'Kept in this browser.';
  const b=$('btnReconnect'); if(b) b.onclick=reconnect;
}
async function reconnect(){
  try{ dirOK = (await dir.requestPermission({mode:'readwrite'}))==='granted'; }catch(e){}
  if(dirOK){ await hydrate(); renderDoc(); save(); }
  showSaveState();
}

/* Reviews from earlier versions kept screenshots inside review.json. Move them out into files. */
async function adopt(raw, fromFolder){
  const doc = raw.doc || raw; let migrated=false;
  for(const s of doc.sections){
    if(s.img && !s.shot){
      s.shot = {id:uid(), file:`shot-${s.id}.jpg`, saved:false};
      keepBlob(s.shot, await (await fetch(s.img)).blob());
      delete s.img; migrated=true;
    } else if(s.shot) s.shot.saved = !!fromFolder;
    if(s.clip) s.clip.saved = !!fromFolder;
    s.reading=false; s.notes ||= []; s.shapes ||= [];
    if(!s.title) s.title='Capture';
  }
  return {doc, migrated};
}
const isReview = raw => { const d = raw && (raw.doc || raw); return !!(d && Array.isArray(d.sections)); };
const pickFolder = () => window.showDirectoryPicker({id:'second-look', mode:'readwrite', startIn:'documents'});
async function hasReview(h){ try{ await h.getFileHandle('review.json'); return true; }catch(e){ return false; } }

$('btnSaveAs').onclick = async ()=>{
  if(!FS){ alert('Saving a review to a folder needs Chrome or Edge. In this browser the review is kept here, and you can still export it.'); return; }
  let h; try{ h=await pickFolder(); }catch(e){ return; }
  const same = dir && await dir.isSameEntry(h).catch(()=>false);
  if(!same){
    if(await hasReview(h) && !confirm(`“${h.name}” already contains a review. Replace it with this one?`)) return;
    for(const s of D.sections){ await getBlob(s.shot,'shots',true); await getBlob(s.clip,'clips',true); }   // pull everything out of the old home first
    for(const s of D.sections){ if(s.shot) s.shot.saved=false; if(s.clip) s.clip.saved=false; }
  }
  setDir(h); save(); showSaveState();
};
async function openFolder(){
  if(!FS){ alert('Opening a saved review folder needs Chrome or Edge.'); return false; }
  let h; try{ h=await pickFolder(); }catch(e){ return false; }
  let f=null;
  try{ f=await (await h.getFileHandle('review.json')).getFile(); }
  catch(e){ for await (const [name,entry] of h.entries()) if(entry.kind==='file' && name.endsWith('.review.json')){ f=await entry.getFile(); break; } }
  if(!f){ alert(`No review found in “${h.name}”. Pick the folder you chose with Save as….`); return false; }
  const text = await f.text(); let raw=null; try{ raw=JSON.parse(text); }catch(e){}
  if(!isReview(raw)){ alert('That file is not a Second Look review.'); return false; }
  await flushNow(); if(manual) toggleClip();
  let known=null;                                                // already in the library? then reopen that entry
  for(const r of await idbAll('reviews')) if(r.handle && await r.handle.isSameEntry(h).catch(()=>false)){ known=r; break; }
  RID = known ? known.id : uid();
  resetAssets(); undoStack.length=0;
  const {doc, migrated} = await adopt(raw, true);
  D=doc; setDir(h); await hydrate(); renderDoc();
  if(migrated && f.name==='review.json') try{ await writeFile('review-backup-old-format.json', text); }catch(e){}
  save(); showSaveState(); return true;
}
async function openReviewFile(file){
  let raw=null; try{ raw=JSON.parse(await file.text()); }catch(e){}
  if(!isReview(raw)){ alert('That file is not a Second Look review.'); return; }
  await flushNow(); if(manual) toggleClip();
  RID=uid(); resetAssets(); undoStack.length=0;
  D=(await adopt(raw,false)).doc; setDir(null); renderDoc(); save(); showSaveState();
}
async function newReview(keep=true){
  if(keep) await flushNow();
  if(manual) toggleClip();
  RID=uid(); D=blankDoc(); undoStack.length=0; resetAssets(); setDir(null); idbDel('currentId'); renderDoc(); showSaveState();
}
$('btnNew').onclick = ()=>newReview();
async function loadReview(rec){
  await flushNow(); if(manual) toggleClip();
  RID=rec.id; D=rec.doc; dir=rec.handle||null; dirOK=false; undoStack.length=0; resetAssets();
  if(dir) try{ dirOK=(await dir.queryPermission({mode:'readwrite'}))==='granted'; }catch(e){}
  D.sections.forEach((x,i)=>{ if(x.reading){ x.reading=false; x.title ||= `Capture ${i+1}`; } });
  await hydrate(); renderDoc(); showSaveState(); idbPut('currentId',RID);
  $('docwrap').scrollTo(0,0);
}

/* ---------- the library: every review this browser holds. It never leaves this computer. ---------- */
let libUrls=[];
async function showLibrary(){
  await flushNow();
  const recs=(await idbAll('reviews')).sort((a,b)=>b.updated-a.updated);
  libUrls.forEach(u=>URL.revokeObjectURL(u)); libUrls=[];
  const grid=$('libGrid'); grid.innerHTML='';
  $('libEmpty').hidden=!!recs.length;
  for(const r of recs){
    const n=r.doc.sections.length, notes=r.doc.sections.reduce((k,x)=>k+x.notes.filter(y=>y.text.trim()).length,0);
    const first=r.doc.sections[0], tb=first && first.shot && await idbGet(first.shot.id,'blobs');
    let src=''; if(tb){ src=URL.createObjectURL(tb); libUrls.push(src); }
    const card=document.createElement('div'); card.className='rcard'+(r.id===RID?' current':'');
    card.innerHTML=`
      <button class="ropen">
        <span class="rthumb">${src?`<img src="${src}" alt="">`:''}</span>
        <span class="rmeta"><b>${esc(r.doc.title||'Untitled review')}</b>
          <span>${new Date(r.updated).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'})} · ${n} capture${n===1?'':'s'} · ${notes} note${notes===1?'':'s'}</span>
          <span>${r.handle?`Saved in folder “${esc(r.handle.name)}”`:'Kept in this browser'}${r.id===RID?' · open now':''}</span></span>
      </button>
      <button class="rdel" title="Remove from this list" aria-label="Remove ${esc(r.doc.title||'Untitled review')}">✕</button>`;
    card.querySelector('.ropen').onclick=async()=>{ $('library').close(); if(r.id!==RID) await loadReview(r); };
    card.querySelector('.rdel').onclick=async()=>{
      if(!confirm(`Remove “${r.doc.title||'Untitled review'}” from this browser?\n\n${r.handle?'The files in its folder stay where they are, so you can open it again later.':'It has not been saved as files, so this deletes it for good.'}`)) return;
      for(const x of r.doc.sections){ if(x.shot) idbDel(x.shot.id,'blobs'); if(x.clip) idbDel(x.clip.id,'blobs'); }
      if(r.id===RID){ clearTimeout(saveTimer); D=blankDoc(); await newReview(false); }
      idbDel(r.id,'reviews'); showLibrary();
    };
    grid.appendChild(card);
  }
  if(!$('library').open) $('library').showModal();
}
$('btnReviews').onclick = showLibrary;
$('libNew').onclick = async ()=>{ $('library').close(); await newReview(); };
$('libOpen').onclick = async ()=>{ if(await openFolder()) $('library').close(); };
$('libClose').onclick = ()=>$('library').close();
$('library').addEventListener('click', e=>{ if(e.target.id==='library') $('library').close(); });

/* ---------- tools ---------- */
document.querySelectorAll('[data-tool]').forEach(b=>b.onclick=()=>setTool(b.dataset.tool));
function setTool(t){
  tool=t;
  document.querySelectorAll('[data-tool]').forEach(b=>b.classList.toggle('on',b.dataset.tool===t));
  document.querySelectorAll('.shot svg').forEach(s=>{ s.classList.toggle('hl-mode',t==='hl'); s.classList.toggle('erase-mode',t==='erase'); });
}
$('btnUndo').onclick = undo;
function undo(){
  const u=undoStack.pop(); if(!u) return;
  const s=D.sections.find(x=>x.id===u.secId); if(!s) return;
  const sh=s.shapes.find(x=>x.id===u.shapeId); if(sh) removeShape(s, sh);
}
function removeShape(s, sh){
  s.shapes = s.shapes.filter(x=>x!==sh);
  const n = sh.note && s.notes.find(x=>x.id===sh.note);
  if(n && !n.text.trim() && !s.shapes.some(x=>x.note===n.id)) s.notes = s.notes.filter(x=>x!==n);
  save(); renderSection(s);
}

/* ---------- sharing a window ---------- */
let paused=false;
async function share(){
  if(!CAN_SHARE){ alert('This browser can\'t share a window. You can still paste or drop screenshots.'); return; }
  let s; try{ s=await navigator.mediaDevices.getDisplayMedia({video:{frameRate:30},audio:false}); }catch(e){ return; }
  if(manual) toggleClip();
  stopRollers();
  if(stream) stream.getTracks().forEach(t=>t.stop());
  stream=s; paused=false; startRollers();
  $('preview').srcObject=stream; $('preview').hidden=false; $('emptyMsg').hidden=true; $('pausedMsg').hidden=true;
  setLive(true); $('btnPause').hidden=false; $('btnShare').textContent='Change window';
  stream.getVideoTracks()[0].onended=()=>{ if(stream===s) sharingStopped(false); };
}
$('btnShare').onclick = share;
// Pausing releases the capture completely; a merely muted track still blocks protected video elsewhere.
$('btnPause').onclick = ()=>{ if(stream){ const s=stream; sharingStopped(true); s.getTracks().forEach(t=>t.stop()); } };
function sharingStopped(isPause){
  stopRollers(); if(manual) toggleClip();
  stream=null; paused=isPause; $('preview').srcObject=null; $('preview').hidden=true;
  $('emptyMsg').hidden=isPause; $('pausedMsg').hidden=!isPause;
  setLive(false); $('btnPause').hidden=true;
  $('btnShare').textContent = isPause ? 'Resume sharing' : 'Share a window';
}
function setLive(on){ $('btnCap').disabled=$('btnClip').disabled=!on; updateClipBtn(); }

/* ---------- capture ---------- */
function frameCanvas(src, w, h){
  const k=Math.min(1, 1800/Math.max(w,h));
  const c=document.createElement('canvas'); c.width=Math.round(w*k); c.height=Math.round(h*k);
  c.getContext('2d').drawImage(src,0,0,c.width,c.height);
  return c;
}
function snapshot(){ const v=$('preview'); return (stream && v.videoWidth) ? frameCanvas(v, v.videoWidth, v.videoHeight) : null; }
function capture(){ const c=snapshot(); if(c) addSection(c); }
$('btnCap').onclick = capture;
async function addSection(c, extra){
  const blob = await new Promise(r=>c.toBlob(r,'image/jpeg',0.9));
  const id=uid();
  const s = {id, title:'', titleEdited:false, reading:true, w:c.width, h:c.height, shot:{id:uid(), file:`shot-${id}.jpg`, saved:false}, shapes:[], notes:[], at:new Date().toISOString(), ...extra};
  keepBlob(s.shot, blob);
  D.sections.push(s); save();
  if(D.sections.length===1) renderDoc();
  else { const el=document.createElement('section'); el.className='sec'; el.dataset.id=s.id; $('doc').appendChild(el); renderSection(s); }
  document.querySelector(`.sec[data-id="${s.id}"]`).scrollIntoView({behavior:'smooth',block:'start'});
  flash();
  if(s.titleEdited) s.reading=false; else readTitle(s,c);
  return s;
}
function flash(){ const v=$('preview'); v.style.transition='none'; v.style.opacity=.3; requestAnimationFrame(()=>{ v.style.transition='opacity .35s'; v.style.opacity=1; }); }

// paste or drop screenshots (and old .review.json files)
function addFile(file){
  if(/json$/.test(file.type) || file.name.endsWith('.json')) return openReviewFile(file);
  if(!file.type.startsWith('image/')) return;
  const i=new Image(); i.onload=()=>{ addSection(frameCanvas(i,i.naturalWidth,i.naturalHeight)); URL.revokeObjectURL(i.src); }; i.src=URL.createObjectURL(file);
}
window.addEventListener('paste', e=>{
  const f=[...(e.clipboardData?.items||[])].find(i=>i.type.startsWith('image/'));
  if(f){ e.preventDefault(); addFile(f.getAsFile()); }
});
window.addEventListener('dragover', e=>{ e.preventDefault(); document.body.classList.add('drop'); });
window.addEventListener('dragleave', e=>{ if(!e.relatedTarget) document.body.classList.remove('drop'); });
window.addEventListener('drop', e=>{ e.preventDefault(); document.body.classList.remove('drop'); [...e.dataTransfer.files].forEach(addFile); });

/* ---------- video ----------
   "Save what just happened": two recorders run staggered and restart every 20 s,
   so the older one always holds the last 10–20 s as a complete, playable file. */
const CLIP_MIME = ['video/mp4;codecs=avc1','video/mp4','video/webm;codecs=vp9','video/webm'].find(t=>window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
const CLIP_OPTS = {videoBitsPerSecond:1500000, ...(CLIP_MIME?{mimeType:CLIP_MIME}:{})};
const ROLL = 20000;
let rollers=[], rollTimer=null, manual=null;
function makeRoller(){
  const r={rec:null, chunks:[], t0:0, want:null, timer:null, live:true};
  r.start=()=>{
    if(!stream || !r.live) return;
    r.chunks=[]; r.t0=Date.now();
    r.rec=new MediaRecorder(stream, CLIP_OPTS);
    r.rec.ondataavailable=e=>{ if(e.data.size) r.chunks.push(e.data); };
    r.rec.onstop=()=>{ const cb=r.want; r.want=null; if(cb) cb(new Blob(r.chunks,{type:r.rec.mimeType||CLIP_MIME||'video/webm'}), (Date.now()-r.t0)/1000); r.start(); };
    r.rec.start(); r.timer=setTimeout(()=>{ if(r.rec.state==='recording') r.rec.stop(); }, ROLL);
  };
  r.kill=()=>{ r.live=false; clearTimeout(r.timer); try{ if(r.rec && r.rec.state!=='inactive') r.rec.stop(); }catch(e){} };
  return r;
}
function startRollers(){ stopRollers(); if(!stream || !window.MediaRecorder) return; const a=makeRoller(), b=makeRoller(); rollers=[a,b]; a.start(); rollTimer=setTimeout(b.start, ROLL/2); }
function stopRollers(){ clearTimeout(rollTimer); rollers.forEach(r=>r.kill()); rollers=[]; }
function saveReplay(){
  if(!stream || manual) return;
  const r = rollers.filter(x=>x.rec && x.rec.state==='recording').sort((a,b)=>a.t0-b.t0)[0];
  if(!r || Date.now()-r.t0 < 1500) return;
  const poster=snapshot();
  clearTimeout(r.timer); r.want=(blob,dur)=>addClipSection(blob,dur,poster,'replay'); r.rec.stop();
}
function toggleClip(){
  if(manual){ const m=manual; manual=null; clearInterval(m.tick); m.rec.stop(); updateClipBtn(); return; }
  if(!stream || !window.MediaRecorder) return;
  stopRollers();
  const m={chunks:[], t0:Date.now(), poster0:snapshot()};
  m.rec=new MediaRecorder(stream, CLIP_OPTS);
  m.rec.ondataavailable=e=>{ if(e.data.size) m.chunks.push(e.data); };
  m.rec.onstop=()=>{ addClipSection(new Blob(m.chunks,{type:m.rec.mimeType||CLIP_MIME||'video/webm'}), (Date.now()-m.t0)/1000, snapshot()||m.poster0, 'clip'); if(stream) startRollers(); };
  m.rec.start(1000); manual=m; m.tick=setInterval(updateClipBtn,500); updateClipBtn();
}
function updateClipBtn(){
  const b=$('btnClip');
  b.classList.toggle('recording', !!manual);
  $('clipLabel').textContent = manual ? `Stop · ${fmtDur((Date.now()-manual.t0)/1000)}` : 'Record a clip';
  $('btnReplay').disabled = !stream || !!manual;
}
function addClipSection(blob, dur, poster, kind){
  if(!poster || !blob.size) return;
  const id=uid(), ext=blob.type.includes('mp4')?'mp4':'webm';
  const clip={id, file:`clip-${id}.${ext}`, dur:Math.max(1,Math.round(dur)), saved:false};
  keepBlob(clip, blob);
  addSection(poster, {clip, kind});
}
async function playClip(s){
  const b=await getBlob(s.clip,'clips',true); showSaveState();
  if(!b){ alert(`Can't find the video “clips/${s.clip.file}”. Open this review's folder with Open… and try again.`); return; }
  const v=$('playerVideo'); if(v.src) URL.revokeObjectURL(v.src);
  v.src=URL.createObjectURL(b); $('player').showModal(); v.play().catch(()=>{});
}
$('btnReplay').onclick = saveReplay;
$('btnClip').onclick = toggleClip;
$('player').addEventListener('click', e=>{ if(e.target.id==='player'){ $('playerVideo').pause(); $('player').close(); } });

/* ---------- keyboard ---------- */
window.addEventListener('keydown', e=>{
  if(e.key==='Escape') closeMenu();
  const typing = e.target.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
  if(typing || $('player').open || $('library').open) return;
  if(e.code==='Space'){ e.preventDefault(); if(e.target.tagName==='BUTTON') e.target.blur(); if(!e.repeat) capture(); }   // Space always captures, even right after clicking a tool
  else if((e.metaKey||e.ctrlKey) && e.key==='z'){ e.preventDefault(); undo(); }
  else if(!e.metaKey && !e.ctrlKey && !e.altKey){
    const k=e.key.toLowerCase();
    if(k==='v') saveReplay(); else if(k==='r') toggleClip();
    else { const t={b:'box',c:'ellipse',h:'hl',e:'erase'}[k]; if(t) setTool(t); }
  }
});

/* ---------- section titles: read the heading off the capture (on-device OCR) ---------- */
let ocrP=null, ocrQueue=Promise.resolve();
function ocr(){
  ocrP ||= (async()=>{
    await loadScript(VENDOR+'tesseract/tesseract.min.js');
    return Tesseract.createWorker('eng', 1, {workerPath:VENDOR+'tesseract/worker.min.js', corePath:VENDOR+'tesseract', langPath:VENDOR+'tesseract', gzip:true});
  })();
  ocrP.catch(()=>{ ocrP=null; });
  return ocrP;
}
function readTitle(s, canvas){
  ocrQueue = ocrQueue.then(async ()=>{
    let title=null;
    try{
      const w = await ocr();
      const tall = layoutOf(s)==='tall';                          // phone: skip the status bar; otherwise read the top third
      const top=Math.round(canvas.height*(tall?0.05:0)), h=Math.round(canvas.height*(tall?0.22:0.3));
      const k=Math.max(1, Math.min(2, 1600/canvas.width));
      const band=document.createElement('canvas'); band.width=Math.round(canvas.width*k); band.height=Math.round(h*k);
      band.getContext('2d').drawImage(canvas,0,top,canvas.width,h,0,0,band.width,band.height);
      const {data} = await w.recognize(band);
      const lines=(data.lines||[]).map(l=>({text:l.text.trim().replace(/[^\p{L}\p{N}&'’ .,:\-]/gu,'').trim(), h:l.bbox.y1-l.bbox.y0, y:l.bbox.y0, conf:l.confidence}))
        .filter(l=>l.conf>55 && l.text.length>=3 && /\p{L}{3}/u.test(l.text) && !/^\d{1,2}[:.]\d{2}/.test(l.text));
      lines.sort((a,b)=>(b.h-a.h)||(a.y-b.y));
      if(lines[0]) title=lines[0].text.split(/\s+/).slice(0,7).join(' ');
    }catch(e){ console.warn('Title reading failed', e); }
    s.reading=false;
    if(!D.sections.includes(s)) return;
    if(!s.titleEdited) s.title = title || `Capture ${D.sections.indexOf(s)+1}`;
    save(); renderSection(s);
  });
}

/* ---------- the document ---------- */
$('docTitle').addEventListener('input', ()=>{ D.title=$('docTitle').innerText.trim(); save(); });
$('docTitle').addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); e.target.blur(); } });
const HERO = `
  <div class="hero">
    <h1>AI builds it.<br>You give it a <em>second look</em>.</h1>
    <p class="lede">Capture any window, mark what's wrong, and the review writes itself: numbered notes beside every screenshot, ready to send to your team or hand to an AI agent.</p>
    <ol class="steps">
      <li><span class="badge">1</span><div><b>Share a window</b><span class="t">A PDF, a slide deck, a website, a design, or a phone mirrored to this computer.</span></div></li>
      <li><span class="badge">2</span><div><b>Capture and mark</b><span class="t">Press Space. Draw a box or circle on the screenshot and type what's wrong.</span></div></li>
      <li><span class="badge">3</span><div><b>Export</b><span class="t">A Word report for people, or Markdown and images for an AI agent.</span></div></li>
    </ol>
    <div class="cta"><button class="go" id="heroShare">Share a window</button><button id="heroSample">See a sample review</button></div>
    <p class="small">Free and open source. Nothing you capture leaves this computer: no account, no upload.<br>Works in Chrome and Edge on Mac and Windows.</p>
  </div>`;
function renderDoc(){
  const empty=!D.sections.length;
  document.querySelector('.page').classList.toggle('empty', empty);
  $('docTitle').hidden=$('docMeta').hidden=empty;
  $('docTitle').innerText=D.title;
  $('docMeta').textContent=new Date(D.created).toLocaleDateString(undefined,{day:'numeric',month:'long',year:'numeric'});
  const doc=$('doc'); doc.innerHTML='';
  if(empty){ doc.innerHTML=HERO; $('heroShare').onclick=share; $('heroShare').hidden=!CAN_SHARE; $('heroSample').onclick=loadSample; return; }
  D.sections.forEach(s=>{ const el=document.createElement('section'); el.className='sec'; el.dataset.id=s.id; doc.appendChild(el); renderSection(s); });
}
function renderSection(s){
  const el=document.querySelector(`.sec[data-id="${s.id}"]`); if(!el) return;
  const i=D.sections.indexOf(s), reading=s.reading && !s.titleEdited, src=urlOf(s.shot);
  el.innerHTML = `
    <div class="sec-head"><span>${i+1}.</span>
      <span class="title ${reading?'reading':''}" contenteditable="true" spellcheck="true" data-ph="Name this capture">${reading?'Reading the heading…':esc(s.title)}</span>
      ${s.clip?'<span class="vtag">video</span>':''}
      <span class="sec-actions">
        <button data-act="up" title="Move up" ${i===0?'disabled':''}>↑</button>
        <button data-act="down" title="Move down" ${i===D.sections.length-1?'disabled':''}>↓</button>
        <button data-act="delsec" title="Delete this section">Delete</button>
      </span></div>
    <div class="sec-body ${layoutOf(s)}">
      <div class="notes-col">
        <ol class="notes">${s.notes.map((n,j)=>`
          <li data-note="${n.id}"><span class="badge ${s.shapes.some(x=>x.note===n.id)?'':'plain'}">${j+1}</span>
          <div class="ntext" contenteditable="true" spellcheck="true" data-ph="Type your note…">${esc(n.text)}</div>
          <button class="x" data-act="delnote" title="Delete note" aria-label="Delete note">✕</button></li>`).join('')}</ol>
        <button class="addnote" data-act="addnote">+ Note without a marker</button>
      </div>
      <div class="shot-col">
        ${src ? `<div class="shot"><img src="${src}" alt="" draggable="false"><svg class="${tool==='hl'?'hl-mode':tool==='erase'?'erase-mode':''}" viewBox="0 0 1 ${s.h/s.w}" preserveAspectRatio="none"></svg></div>`
              : `<div class="missing">This image isn't loaded yet. Click “Keep saving to…” at the top right to reconnect the review folder.</div>`}
        ${s.clip?`<button class="play" data-act="play">Play video · ${fmtDur(s.clip.dur)}</button>`:''}
      </div>
    </div>`;
  const svg=el.querySelector('svg'); if(svg) drawShapes(s,svg);
  wireSection(s, el);
}
function drawShapes(s, svg){
  svg.innerHTML='';
  s.shapes.filter(x=>x.type==='hl').forEach(x=>svg.appendChild(shapeEl(s,x)));       // highlights under outlines and badges
  s.shapes.filter(x=>x.type!=='hl').forEach(x=>{
    svg.appendChild(shapeEl(s,x));
    const n=s.notes.findIndex(y=>y.id===x.note);
    if(n>=0) svg.appendChild(badgeEl(s, x.x, x.y, n+1));
  });
}
function shapeEl(s, x){
  let e;
  if(x.type==='hl'){
    e=document.createElementNS(NS,'polyline'); e.setAttribute('points',x.pts.map(p=>p.join(',')).join(' '));
    Object.assign(e.style,{fill:'none',stroke:'var(--hl)',strokeOpacity:.5,strokeWidth:U(s)*1.2,strokeLinecap:'round',strokeLinejoin:'round',mixBlendMode:'multiply'});
  } else {
    const r=norm(x);
    if(x.type==='box'){ e=document.createElementNS(NS,'rect'); e.setAttribute('x',r.x); e.setAttribute('y',r.y); e.setAttribute('width',r.w); e.setAttribute('height',r.h); e.setAttribute('stroke-dasharray','6 4'); }
    else { e=document.createElementNS(NS,'ellipse'); e.setAttribute('cx',r.x+r.w/2); e.setAttribute('cy',r.y+r.h/2); e.setAttribute('rx',r.w/2); e.setAttribute('ry',r.h/2); }
    e.setAttribute('vector-effect','non-scaling-stroke');
    Object.assign(e.style,{fill:'none',stroke:MARK,strokeWidth:'2.5px'});
  }
  return e;
}
function badgeEl(s, x, y, num){
  const R=U(s), g=document.createElementNS(NS,'g'), c=document.createElementNS(NS,'circle'), t=document.createElementNS(NS,'text');
  c.setAttribute('cx',x); c.setAttribute('cy',y); c.setAttribute('r',R); c.setAttribute('fill',MARK); c.setAttribute('stroke','#fff'); c.setAttribute('stroke-width',R*0.16);
  t.setAttribute('x',x); t.setAttribute('y',y+R*0.42); t.setAttribute('text-anchor','middle'); t.setAttribute('font-size',R*1.2); t.setAttribute('font-weight',700); t.setAttribute('fill','#fff'); t.setAttribute('font-family','Helvetica,Arial,sans-serif'); t.textContent=num;
  g.append(c,t); return g;
}
const norm = x => ({x:Math.min(x.x,x.x+x.w), y:Math.min(x.y,x.y+x.h), w:Math.abs(x.w), h:Math.abs(x.h)});
function shapeAt(s, px, py){
  const pad=U(s)*0.6;
  const solid=s.shapes.filter(z=>z.type!=='hl' && px>=z.x-pad && px<=z.x+z.w+pad && py>=z.y-pad && py<=z.y+z.h+pad).sort((a,b)=>a.w*a.h-b.w*b.h)[0];
  return solid || [...s.shapes].reverse().find(z=>z.type==='hl' && z.pts.some(([x,y])=>Math.hypot(x-px,y-py)<U(s)*0.9));
}

function wireSection(s, el){
  const title=el.querySelector('.title');
  title.addEventListener('focus',()=>{ if(s.reading && !s.titleEdited){ title.innerText=''; title.classList.remove('reading'); } });
  title.addEventListener('input',()=>{ s.title=title.innerText.trim(); s.titleEdited=true; save(); });
  title.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); title.blur(); } });

  const move = d => { const i=D.sections.indexOf(s), j=i+d; if(j<0||j>=D.sections.length) return; [D.sections[i],D.sections[j]]=[D.sections[j],D.sections[i]]; save(); renderDoc(); document.querySelector(`.sec[data-id="${s.id}"]`).scrollIntoView({block:'nearest'}); };
  el.querySelector('[data-act="up"]').onclick=()=>move(-1);
  el.querySelector('[data-act="down"]').onclick=()=>move(1);
  el.querySelector('[data-act="delsec"]').onclick=()=>{
    if(!confirm(s.clip?'Delete this section and its video?':'Delete this section?')) return;
    D.sections=D.sections.filter(x=>x!==s); dropAsset(s.shot,'shots'); dropAsset(s.clip,'clips'); save(); renderDoc(); showSaveState();
  };
  el.querySelector('[data-act="addnote"]').onclick=()=>addNote(s);
  const pb=el.querySelector('[data-act="play"]'); if(pb) pb.onclick=()=>playClip(s);
  el.querySelectorAll('.notes li').forEach(li=>{
    const n=s.notes.find(x=>x.id===li.dataset.note), t=li.querySelector('.ntext');
    t.addEventListener('input',()=>{ n.text=t.innerText; save(); });
    t.addEventListener('keydown',e=>{
      if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); addNote(s, s.notes.indexOf(n)+1); }
      if(e.key==='Backspace' && !t.innerText.trim()){ e.preventDefault(); const i=s.notes.indexOf(n); removeNote(s,n); focusNote(s, s.notes[Math.max(0,i-1)]); }
    });
    li.querySelector('[data-act="delnote"]').onclick=()=>removeNote(s,n);
  });

  const svg=el.querySelector('svg'); if(!svg) return;
  let cur=null;
  const pt = e => { const r=svg.getBoundingClientRect(); return [(e.clientX-r.left)/r.width, (e.clientY-r.top)/r.width]; };
  svg.addEventListener('pointerdown',e=>{
    const [x,y]=pt(e);
    if(tool==='erase'){ const hit=shapeAt(s,x,y); if(hit) removeShape(s,hit); return; }
    svg.setPointerCapture(e.pointerId);
    cur = tool==='hl' ? {id:uid(),type:'hl',pts:[[x,y]]} : {id:uid(),type:tool,x,y,w:0,h:0};
    cur.el=shapeEl(s,cur); svg.appendChild(cur.el);
  });
  svg.addEventListener('pointermove',e=>{
    if(!cur) return; const [x,y]=pt(e);
    if(cur.type==='hl') cur.pts.push([+x.toFixed(4),+y.toFixed(4)]); else { cur.w=x-cur.x; cur.h=y-cur.y; }
    const fresh=shapeEl(s,cur); cur.el.replaceWith(fresh); cur.el=fresh;
  });
  const finish = ()=>{
    if(!cur) return; const c=cur; cur=null; c.el.remove(); delete c.el;
    const tiny = c.type==='hl' ? c.pts.length<2 : (Math.abs(c.w)<U(s)*0.5 && Math.abs(c.h)<U(s)*0.5);
    if(tiny) return;
    if(c.type!=='hl'){ Object.assign(c, norm(c)); const n={id:uid(),text:''}; s.notes.push(n); c.note=n.id; }
    s.shapes.push(c); undoStack.push({secId:s.id, shapeId:c.id}); save();
    renderSection(s);
    if(c.note) focusNote(s, s.notes.find(n=>n.id===c.note));
  };
  svg.addEventListener('pointerup', finish);
  svg.addEventListener('pointercancel', ()=>{ if(cur){ cur.el.remove(); cur=null; } });
}
function addNote(s, at=s.notes.length){ const n={id:uid(),text:''}; s.notes.splice(at,0,n); save(); renderSection(s); focusNote(s,n); }
function removeNote(s,n){ s.notes=s.notes.filter(x=>x!==n); s.shapes=s.shapes.filter(x=>x.note!==n.id); save(); renderSection(s); }
function focusNote(s,n){
  if(!n) return;
  const t=document.querySelector(`.sec[data-id="${s.id}"] li[data-note="${n.id}"] .ntext`); if(!t) return;
  t.focus(); const r=document.createRange(); r.selectNodeContents(t); r.collapse(false); const sel=getSelection(); sel.removeAllRanges(); sel.addRange(r);
}

/* ---------- burn the mark-up into the image (for exports) ---------- */
function drawMarkup(x, s, W){
  const u=U(s);
  x.save(); x.globalCompositeOperation='multiply'; x.strokeStyle='rgba(255,216,74,0.6)'; x.lineWidth=u*1.2*W; x.lineCap='round'; x.lineJoin='round';
  s.shapes.filter(z=>z.type==='hl').forEach(z=>{ x.beginPath(); z.pts.forEach(([px,py],i)=>i?x.lineTo(px*W,py*W):x.moveTo(px*W,py*W)); x.stroke(); });
  x.restore();
  const lw=Math.max(2, u*0.22*W);
  s.shapes.filter(z=>z.type!=='hl').forEach(z=>{
    x.save(); x.strokeStyle=MARK; x.lineWidth=lw; x.beginPath();
    if(z.type==='box'){ x.setLineDash([lw*2.5,lw*1.6]); x.rect(z.x*W,z.y*W,z.w*W,z.h*W); }
    else x.ellipse((z.x+z.w/2)*W,(z.y+z.h/2)*W,z.w*W/2,z.h*W/2,0,0,Math.PI*2);
    x.stroke(); x.restore();
  });
  s.shapes.filter(z=>z.type!=='hl').forEach(z=>{
    const n=s.notes.findIndex(y=>y.id===z.note); if(n<0) return;
    const R=u*W; x.beginPath(); x.arc(z.x*W,z.y*W,R,0,Math.PI*2); x.fillStyle=MARK; x.fill(); x.lineWidth=R*0.16; x.strokeStyle='#fff'; x.stroke();
    x.fillStyle='#fff'; x.font=`700 ${Math.round(R*1.2)}px Helvetica,Arial,sans-serif`; x.textAlign='center'; x.textBaseline='middle'; x.fillText(n+1,z.x*W,z.y*W+R*0.05);
  });
}
async function flatten(s){
  const b=await getBlob(s.shot,'shots'); if(!b) return null;
  const img=await createImageBitmap(b), W=img.width, H=img.height;
  const c=document.createElement('canvas'); c.width=W; c.height=H; const x=c.getContext('2d');
  x.drawImage(img,0,0); drawMarkup(x,s,W);
  const blob=await new Promise(r=>c.toBlob(r,'image/jpeg',0.9));
  return {blob, bytes:new Uint8Array(await blob.arrayBuffer()), W, H, type:'jpg'};
}
// video → animated GIF, so a Word report carries the moving picture itself
const once = (el,ev) => new Promise((res,rej)=>{ el.addEventListener(ev,res,{once:true}); el.addEventListener('error',rej,{once:true}); });
async function clipToGif(s){
  const blob=await getBlob(s.clip,'clips',true); if(!blob) return null;
  const {GIFEncoder, quantize, applyPalette} = await import(VENDOR+'gifenc.esm.js');
  const v=document.createElement('video'); v.muted=true; v.playsInline=true; v.preload='auto'; v.src=URL.createObjectURL(blob);
  try{
    await once(v,'loadeddata');
    let dur=v.duration;
    if(!isFinite(dur)){ v.currentTime=1e7; await once(v,'seeked'); dur=isFinite(v.duration)?v.duration:s.clip.dur; }
    const W=layoutOf(s)==='wide'?480:300, H=Math.round(W*s.h/s.w);
    const c=document.createElement('canvas'); c.width=W; c.height=H; const x=c.getContext('2d',{willReadFrequently:true});
    const n=Math.max(1, Math.min(100, Math.floor(dur*5))), step=dur/n, gif=GIFEncoder();
    for(let i=0;i<n;i++){
      v.currentTime=Math.min(i*step, Math.max(0,dur-0.05)); await once(v,'seeked');
      x.drawImage(v,0,0,W,H); drawMarkup(x,s,W);
      const d=x.getImageData(0,0,W,H).data, pal=quantize(d,256);
      gif.writeFrame(applyPalette(d,pal), W, H, {palette:pal, delay: i===n-1 ? 2000 : Math.round(step*1000)});
    }
    gif.finish(); return {bytes:gif.bytes(), W, H, type:'gif'};
  } finally { URL.revokeObjectURL(v.src); }
}

/* ---------- exports ---------- */
const slug = t => (t||'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'-').replace(/^-+|-+$/g,'').slice(0,40);
const fileBase = () => `${(D.title||'review').replace(/[^\p{L}\p{N}\- ]+/gu,'').trim().replace(/\s+/g,'-')||'review'}-${new Date().toISOString().slice(0,10)}`;
function say(html, ms){ $('status').innerHTML=html; if(ms) setTimeout(showSaveState, ms); }
function closeMenu(){ $('exportMenu').hidden=true; $('btnExport').setAttribute('aria-expanded','false'); }
$('btnExport').onclick = e=>{ e.stopPropagation(); const m=$('exportMenu'); m.hidden=!m.hidden; $('btnExport').setAttribute('aria-expanded', String(!m.hidden)); };
document.addEventListener('click', e=>{ if(!e.target.closest('.menu-wrap')) closeMenu(); });
function ready(){
  closeMenu();
  if(D.sections.length) return true;
  alert('Nothing to export yet. Capture something first.'); return false;
}

$('btnWord').onclick = async ()=>{
  if(!ready()) return;
  say('Building the Word report…');
  try{
    await loadScript(VENDOR+'docx.iife.js'); await io; if(connected()) await flushAssets();
    const {Document,Packer,Paragraph,TextRun,HeadingLevel,ImageRun,Table,TableRow,TableCell,WidthType,TableBorders,TableLayoutType,ExternalHyperlink} = window.docx;
    const kids=[
      new Paragraph({heading:HeadingLevel.TITLE, children:[new TextRun(D.title||'Review')]}),
      new Paragraph({children:[new TextRun({text:$('docMeta').textContent, color:'777777'})], spacing:{after:300}}),
    ];
    const nClips=D.sections.filter(s=>s.clip).length; let done=0;
    for(const [i,s] of D.sections.entries()){
      let img=null;
      if(s.clip){ say(`Turning videos into moving pictures… ${++done}/${nClips}`); try{ img=await clipToGif(s); }catch(e){ console.warn('GIF failed',e); } }
      img ||= await flatten(s);
      const lay=layoutOf(s), imgW = lay==='wide'?620 : lay==='square'?270 : 250;
      const notes = s.notes.some(n=>n.text.trim())
        ? s.notes.map((n,j)=>n.text.trim() ? new Paragraph({spacing:{after:140}, children:[new TextRun({text:`${j+1}.  `,bold:true,color:'D93A2B'}), new TextRun(n.text.trim())]}) : null).filter(Boolean)
        : [new Paragraph({children:[new TextRun({text:'(no notes)',italics:true,color:'999999'})]})];
      const pic = img ? [new Paragraph({spacing:{after:120}, children:[new ImageRun({type:img.type,data:img.bytes,transformation:{width:imgW,height:Math.round(img.H*imgW/img.W)}})]})]
                      : [new Paragraph({children:[new TextRun({text:'(image missing)',italics:true,color:'999999'})]})];
      if(s.clip){
        const label=`Full-quality video (${fmtDur(s.clip.dur)})`;
        pic.push(new Paragraph({spacing:{after:120}, children: connected()
          ? [new ExternalHyperlink({link:`clips/${s.clip.file}`, children:[new TextRun({text:label, style:'Hyperlink'})]})]
          : [new TextRun({text:`${label}: clips/${s.clip.file} in the review folder`, color:'777777', size:18})]}));
      }
      kids.push(new Paragraph({heading:HeadingLevel.HEADING_1, pageBreakBefore:i>0, children:[new TextRun(`${i+1}. ${s.title||'Capture '+(i+1)}`), ...(s.clip?[new TextRun({text:'   video', size:20, color:'D93A2B'})]:[])]}));
      if(lay==='wide') kids.push(...pic, ...notes);
      else kids.push(new Table({
        width:{size:9360,type:WidthType.DXA}, columnWidths:[5360,4000], layout:TableLayoutType.FIXED, borders:TableBorders.NONE,
        rows:[new TableRow({children:[
          new TableCell({width:{size:5360,type:WidthType.DXA}, margins:{right:240}, children:notes}),
          new TableCell({width:{size:4000,type:WidthType.DXA}, children:pic})
        ]})]
      }));
    }
    const blob=await Packer.toBlob(new Document({creator:'Second Look', title:D.title||'Review', styles:{default:{document:{run:{font:'Aptos',size:24}}}}, sections:[{children:kids}]}));
    const name=fileBase()+'.docx';
    // saved inside the review folder so the video links (clips/…) open straight from Word
    if(connected()){ try{ await writeFile(name, blob); say(`Saved <b>${esc(name)}</b> in “${esc(dir.name)}”`, 5000); return; }catch(e){ console.warn(e); } }
    downloadBlob(blob, name); say('Word report downloaded', 4000);
  }catch(e){ console.error(e); say('<span class="warn">The Word export failed.</span> '+esc(e.message||''), 8000); }
};

// Where a marker sits, in words, for readers (and models) that can't see the image well
function region(s, z){
  const cx=z.x+z.w/2, cy=(z.y+z.h/2)/(s.h/s.w);
  const col=cx<1/3?'left':cx<2/3?'centre':'right', row=cy<1/3?'top':cy<2/3?'middle':'bottom';
  return row==='middle' && col==='centre' ? 'centre' : `${row} ${col}`;
}
$('btnAI').onclick = async ()=>{
  if(!ready()) return;
  say('Preparing files for an AI agent…');
  try{
    await io; if(connected()) await flushAssets();
    const files=[], nNotes=D.sections.reduce((n,s)=>n+s.notes.filter(x=>x.text.trim()).length,0);
    let md=`# Review: ${D.title||'Untitled'}\n\n${$('docMeta').textContent} · ${D.sections.length} capture${D.sections.length===1?'':'s'} · ${nNotes} note${nNotes===1?'':'s'}\n\n`
      + `This is feedback from a human reviewer. Each section is one capture; its image is in this folder. Red numbered markers on the image match the numbered notes. Notes marked "whole capture" have no marker. Please address every note.\n`;
    for(const [i,s] of D.sections.entries()){
      const title=s.title||`Capture ${i+1}`, fname=`${String(i+1).padStart(2,'0')}-${slug(title)||'capture'}.jpg`;
      const img=await flatten(s); if(img) files.push({name:fname, blob:img.blob});
      md += `\n## ${i+1}. ${title}\n\n${img?`![${title}](${fname})`:'(image missing)'}\n\n`;
      const lines=s.notes.map((n,j)=>{
        if(!n.text.trim()) return null;
        const z=s.shapes.find(x=>x.note===n.id);
        return `${j+1}. [${z?`marker ${j+1}, ${region(s,z)}`:'whole capture'}] ${n.text.trim().replace(/\s*\n\s*/g,' ')}`;
      }).filter(Boolean);
      md += lines.length ? lines.join('\n')+'\n' : '_No notes on this capture._\n';
      if(s.clip) md += connected() ? `\nScreen recording of the problem (${fmtDur(s.clip.dur)}): ../clips/${s.clip.file}\n` : `\nA ${fmtDur(s.clip.dur)} screen recording of this exists in the original review.\n`;
    }
    files.unshift({name:'feedback.md', blob:new Blob([md],{type:'text/markdown'})});
    try{ await navigator.clipboard.writeText(md); }catch(e){}
    if(connected()){
      try{ await dir.removeEntry('for-ai',{recursive:true}); }catch(e){}
      for(const f of files) await writeFile(f.name, f.blob, 'for-ai');
      say(`Saved in “${esc(dir.name)}/for-ai”. Point your agent at <b>feedback.md</b>.`, 8000);
    } else {
      downloadBlob(await zip(files), fileBase()+'-for-ai.zip');
      say('Downloaded a zip with <b>feedback.md</b> and the images', 6000);
    }
  }catch(e){ console.error(e); say('<span class="warn">The export failed.</span> '+esc(e.message||''), 8000); }
};

// minimal ZIP writer (stored, no compression — the images are already compressed)
const CRC=(()=>{ const t=new Uint32Array(256); for(let n=0;n<256;n++){ let c=n; for(let k=0;k<8;k++) c=c&1?0xEDB88320^(c>>>1):c>>>1; t[n]=c>>>0; } return t; })();
function crc32(u8){ let c=~0; for(let i=0;i<u8.length;i++) c=CRC[(c^u8[i])&255]^(c>>>8); return (~c)>>>0; }
async function zip(files){
  const enc=new TextEncoder(), parts=[], central=[]; let off=0;
  for(const f of files){
    const data=new Uint8Array(await f.blob.arrayBuffer()), name=enc.encode(f.name), crc=crc32(data);
    const lh=new DataView(new ArrayBuffer(30)); lh.setUint32(0,0x04034b50,true); lh.setUint16(4,20,true); lh.setUint16(6,0x0800,true); lh.setUint32(14,crc,true); lh.setUint32(18,data.length,true); lh.setUint32(22,data.length,true); lh.setUint16(26,name.length,true);
    const ch=new DataView(new ArrayBuffer(46)); ch.setUint32(0,0x02014b50,true); ch.setUint16(4,20,true); ch.setUint16(6,20,true); ch.setUint16(8,0x0800,true); ch.setUint32(16,crc,true); ch.setUint32(20,data.length,true); ch.setUint32(24,data.length,true); ch.setUint16(28,name.length,true); ch.setUint32(42,off,true);
    parts.push(lh.buffer,name,data); central.push(ch.buffer,name); off+=30+name.length+data.length;
  }
  const csize=central.reduce((n,p)=>n+p.byteLength,0);
  const end=new DataView(new ArrayBuffer(22)); end.setUint32(0,0x06054b50,true); end.setUint16(8,files.length,true); end.setUint16(10,files.length,true); end.setUint32(12,csize,true); end.setUint32(16,off,true);
  return new Blob([...parts,...central,end.buffer],{type:'application/zip'});
}

/* ---------- sample review (drawn in code, so nothing real is shown) ---------- */
function rr(x,X,Y,W,H,r,fill){ x.beginPath(); x.roundRect(X,Y,W,H,r); x.fillStyle=fill; x.fill(); }
function samplePhone(){
  const c=document.createElement('canvas'); c.width=780; c.height=1688; const x=c.getContext('2d'); x.scale(2,2);
  x.fillStyle='#f6f5f1'; x.fillRect(0,0,390,844);
  x.fillStyle='#1d1c1a'; x.font='600 15px Helvetica,Arial,sans-serif'; x.fillText('9:41',24,34);
  x.font='700 30px Helvetica,Arial,sans-serif'; x.fillText('My Tasks',24,104);
  x.font='15px Helvetica,Arial,sans-serif'; x.fillStyle='#77756f'; x.fillText('3 due this week',24,130);
  [['Prepare slides for Thursday\'s revi…','Due Thu · Marketing'],['Send invoice to Northwind','Due Fri · Finance'],['Book venue for the offsite','Due next week · Team']].forEach(([t,d],i)=>{
    const y=160+i*104; rr(x,20,y,350,92,14,'#fff');
    x.strokeStyle='#c9c7c0'; x.lineWidth=2; x.beginPath(); x.arc(48,y+46,11,0,7); x.stroke();
    x.fillStyle='#1d1c1a'; x.font='600 16px Helvetica,Arial,sans-serif'; x.fillText(t,74,y+40);
    x.fillStyle='#77756f'; x.font='13px Helvetica,Arial,sans-serif'; x.fillText(d,74,y+62);
  });
  rr(x,20,690,350,52,14,'#dcdad3'); x.fillStyle='#c4c2bb'; x.font='600 16px Helvetica,Arial,sans-serif'; x.textAlign='center'; x.fillText('Add a task',195,722); x.textAlign='left';
  x.fillStyle='#fff'; x.fillRect(0,772,390,72); x.fillStyle='#77756f'; x.font='12px Helvetica,Arial,sans-serif';
  ['Tasks','Calendar','Team','Profile'].forEach((t,i)=>{ x.textAlign='center'; x.fillText(t,49+i*97,815); }); x.textAlign='left';
  return c;
}
function sampleSlide(){
  const c=document.createElement('canvas'); c.width=1600; c.height=900; const x=c.getContext('2d');
  x.fillStyle='#fff'; x.fillRect(0,0,1600,900);
  x.fillStyle='#1d1c1a'; x.font='700 64px Helvetica,Arial,sans-serif'; x.fillText('Q3 launch plan',90,150);
  x.font='32px Helvetica,Arial,sans-serif'; x.fillStyle='#333';
  ['Lauch in three cities by September','Two partner schools per city','Weekly review with the growth team'].forEach((t,i)=>{ x.beginPath(); x.arc(104,300+i*84,7,0,7); x.fill(); x.fillText(t,130,311+i*84); });
  [220,330,180,410].forEach((h,i)=>rr(x,960+i*130,700-h,90,h,8,['#c9c7c0','#a9a7a0','#c9c7c0','#d93a2b'][i]));
  x.fillStyle='#1d1c1a'; x.fillRect(930,700,560,3);
  x.fillStyle='#9b9992'; x.font='22px Helvetica,Arial,sans-serif'; x.fillText('Draft · not for circulation',90,840);
  return c;
}
async function loadSample(){
  D.title='Sample review';
  const add = async (canvas, title, marks, plain)=>{
    const s=await addSection(canvas,{title, titleEdited:true, reading:false});
    marks.forEach(([type,x,y,w,h,text])=>{ const n={id:uid(),text}; s.notes.push(n); s.shapes.push({id:uid(),type,x,y,w,h,note:n.id}); });
    (plain||[]).forEach(text=>s.notes.push({id:uid(),text}));
    renderSection(s);
  };
  await add(samplePhone(), 'My Tasks', [
    ['box', 0.175,0.455,0.745,0.085, 'The title is cut off. Let it wrap onto a second line.'],
    ['ellipse', 0.04,1.75,0.92,0.17, 'This button is hard to read. Use white text on the brand colour.'],
  ], ['Overall: the cards feel cramped. Add more space between them.']);
  await add(sampleSlide(), 'Q3 launch plan', [
    ['box', 0.05,0.165,0.40,0.045, 'Typo: "Lauch" should be "Launch".'],
    ['box', 0.57,0.17,0.37,0.29, 'The chart has no labels or units. What does each bar show?'],
  ]);
  $('docTitle').innerText=D.title; save();
  document.querySelector('.sec').scrollIntoView({block:'start'});
}

/* ---------- small helpers ---------- */
function fmtDur(t){ t=Math.round(t); return `${Math.floor(t/60)}:${String(t%60).padStart(2,'0')}`; }
function esc(s){ return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function downloadBlob(b,name){ const a=document.createElement('a'); a.href=URL.createObjectURL(b); a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),5000); }
window.addEventListener('beforeunload', e=>{ if(manual){ e.preventDefault(); e.returnValue=''; } });

/* ---------- start ---------- */
(async()=>{
  $('pasteKey').textContent = IS_MAC ? '⌘V' : 'Ctrl+V';
  $('btnUndo').title = `Undo the last mark (${IS_MAC?'⌘Z':'Ctrl+Z'})`;
  $('phoneHelp').innerHTML = [
    IS_MAC ? '<b>iPhone:</b> plug it in, open QuickTime Player, choose File → New Movie Recording, click the small arrow beside the record button and pick your iPhone. Then share the QuickTime window here.'
           : '<b>iPhone:</b> Windows has no built-in iPhone mirroring. Take screenshots on the phone and paste or drag them in, or use an AirPlay receiver app and share its window.',
    '<b>Android:</b> install the free tool <code>scrcpy</code>, plug the phone in with USB debugging on, run <code>scrcpy</code>, then share its window here.',
  ].map(t=>`<li>${t}</li>`).join('');
  if(!CAN_SHARE){ $('banner').hidden=false; $('banner').textContent='This device can\'t share a window. Open Second Look on a computer, or paste and drop screenshots here.'; $('btnShare').disabled=true; document.body.classList.add('noshare'); }
  else if(!FS){ $('banner').hidden=false; $('banner').textContent='This browser can\'t save a review to a folder. Capturing, marking up and exporting all work, and the review is kept in this browser. For saved review folders, use Chrome or Edge.'; }

  db=await openDB();
  const old=await idbGet('current');                             // from before the library existed: move it in
  if(isReview(old) && old.sections.length){ const id=uid(); idbPut(id,{id, doc:old, handle:await idbGet('handle'), updated:Date.now()},'reviews'); idbPut('currentId',id); }
  if(old){ idbDel('current'); idbDel('handle'); }
  const cur=await idbGet('currentId'), rec=cur && await idbGet(cur,'reviews');
  if(rec && isReview(rec.doc)) await loadReview(rec); else { renderDoc(); showSaveState(); }
  if(!D.sections.length && new URLSearchParams(location.search).has('sample')) loadSample();   // shareable demo link: /?sample
})();
