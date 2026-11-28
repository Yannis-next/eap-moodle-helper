// ==UserScript==
// @name         EAP Moodle Helper
// @namespace    eap-local-helper
// @version      4.0.1
// @description  Χρονοδιάγραμμα μελέτης, ημερολόγιο και αναζήτηση δραστηριοτήτων ΕΑΠ
// @match        https://courses.eap.gr/*
// @grant        none
// @run-at       document-idle
// @homepageURL  https://yannis-next.github.io/eap-moodle-helper/
// @updateURL    https://yannis-next.github.io/eap-moodle-helper/EAP-Moodle-Helper.user.js
// @downloadURL  https://yannis-next.github.io/eap-moodle-helper/EAP-Moodle-Helper.user.js
// ==/UserScript==
(function () {
  'use strict';
  // Shared state: only validated schedules are accepted.
  const CACHE = 'eap-helper-schedule-v3';
  const courseId = location.pathname === '/course/view.php' ? new URLSearchParams(location.search).get('id') : null;
  let schedule = [], source = '', lastUpdated = null, busy = false, sourceCourse = null, sourceName = '';
  const activeOn = (rows, day) => rows.length && rows[0][1] <= day && day <= rows.at(-1)[2];
  const athensDay = () => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Athens',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(x=>[x.type,x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  };
  const norm = s => String(s).normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();
  const addDay = s => new Date(Date.parse(s)+86400000).toISOString().slice(0,10);
  function validate(rows) {
    if (!Array.isArray(rows) || rows.length < 13 || rows.length > 20) throw Error('Μη αναγνωρίσιμο χρονοδιάγραμμα');
    let n=0, prev=null;
    for (const r of rows) {
      if (!Array.isArray(r) || !Number.isInteger(r[0]) || r[0]<0 || ![r[1],r[2]].every(x=>typeof x==='string' && /^\d{4}-\d{2}-\d{2}$/.test(x) && Number.isFinite(Date.parse(x)) && new Date(x).toISOString().slice(0,10)===x)) throw Error('Μη έγκυρη ημερομηνία');
      if (r[2]<r[1] || (prev && addDay(prev)!==r[1]) || (r[0] && (r[0]!==++n || (Date.parse(r[2])-Date.parse(r[1]))/86400000>6))) throw Error('Ασυνεχείς εβδομάδες');
      prev=r[2];
    }
    if(n!==13 || rows[0][0]!==1 || rows.at(-1)[0]!==13) throw Error('Δεν βρέθηκαν 13 εβδομάδες');
    return rows;
  }
  function readCache() {
    try {const c=JSON.parse(localStorage.getItem(CACHE)||'null'); if(!c || !c.courses)return null; return c;} catch {return null;}
  }
  // Moodle course pages expose the official course name in the browser title.
  function courseNameFromTitle(title) {
    const clean=String(title||'').replace(/\s+/gu,' ').trim();
    const prefix=clean.match(/^([^:]+):\s*/u);
    const isCourse=prefix&&['μαθημα','course'].includes(norm(prefix[1]).trim());
    const name=isCourse?clean.slice(prefix[0].length).trim():clean;
    // Recognize letter/number course codes, with or without a separating space.
    const code=name.match(/^([\p{L}]{1,12})\s*[-–]?\s*(\d{1,5}[\p{L}]?)(?=\s*(?::|[–—]|$))/u);
    if(code)return code[1].toUpperCase()+code[2].toUpperCase();
    return isCourse?name.slice(0,180):'';
  }
  // Moodle course IDs are internal numbers; retain only verified human-readable course codes.
  // Resolve labels locally from navigation links, visited courses and existing schedule metadata.
  const COURSE_LABELS_KEY = 'eap-helper-course-labels-v1';
  const courseLabels = new Map();
  try {
    const saved=JSON.parse(localStorage.getItem(COURSE_LABELS_KEY)||'{}');
    if(saved && typeof saved==='object' && !Array.isArray(saved))
      for(const [id,value] of Object.entries(saved))
        if(/^\d+$/.test(id) && typeof value==='string' && value.length<=40)courseLabels.set(id,value);
  }catch{}
  function shortCourseCode(raw){
    const s=String(raw||'').replace(/\s+/gu,' ').trim().replace(/^(?:Μάθημα|Course):\s*/iu,'');
    const pattern=/([\p{L}]{1,12})\s*[-–]?\s*(\d{1,5}[\p{L}]?)(?=\s*(?::|[-–—]|$)|\s)/u;
    let m=s.match(new RegExp('^'+pattern.source,'u'));
    // Moodle links sometimes prefix the code with an accessible text like "Μάθημα".
    if(!m)m=s.match(/(?:^|[\s:([{])([\p{Lu}]{2,12})\s*[-–]?\s*(\d{1,5}[\p{L}]?)(?=\s*(?::|[-–—]|$)|\s)/u);
    if(!m || /^(?:ΘΕ|THE|COURSE|ΜΑΘΗΜΑ)$/iu.test(m[1]))return '';
    return m[1].toUpperCase()+m[2].toUpperCase();
  }
  function rememberCourseLabels(doc=document,base=location.href){
    let changed=false;
    function add(id,raw){
      const code=shortCourseCode(raw);
      if(!/^\d+$/.test(String(id)) || id==='1' || !code || courseLabels.get(String(id))===code)return;
      courseLabels.set(String(id),code);changed=true;
    }
    for(const a of doc.querySelectorAll('a[href*="course/view.php"]')){
      let u;try{u=new URL(a.getAttribute('href'),base);}catch{continue;}
      if(u.origin!==location.origin || u.pathname!=='/course/view.php')continue;
      const id=u.searchParams.get('id');
      if(id)for(const text of [a.textContent,a.title,a.getAttribute('aria-label')]){if(shortCourseCode(text)){add(id,text);break;}}
    }
    const cached=readCache()?.courses;
    if(cached)for(const [id,item] of Object.entries(cached))add(id,item?.name);
    if(courseId)add(courseId,currentCourseName());
    if(changed){try{localStorage.setItem(COURSE_LABELS_KEY,JSON.stringify(Object.fromEntries(courseLabels)));}catch{}}
  }
  function friendlyCourseLabel(id,raw=''){
    const value=shortCourseCode(raw);
    if(value)return value;
    return courseLabels.get(String(id)) || (id ? 'Θ.Ε. '+id : String(raw||'').trim() || 'Χωρίς αναγνωρισμένη Θ.Ε.');
  }
  function currentCourseName() {
    if(!courseId)return '';
    return courseNameFromTitle(document.title)||courseNameFromTitle(document.querySelector('#page-header h1')?.textContent);
  }
  function refreshCachedCourseName() {
    if(!courseId)return;
    const name=currentCourseName(), c=readCache(), entry=c?.courses[courseId];
    if(!name||!entry||entry.name===name)return;
    // Migrate old cached labels on visit, without refetching Excel or changing its timestamp.
    entry.name=name;
    try{localStorage.setItem(CACHE,JSON.stringify(c));}catch{}
  }
  function applyEntry(id, entry) {
    schedule=validate(entry.rows);
    lastUpdated=Number.isFinite(entry.saved)&&Number.isFinite(new Date(entry.saved).getTime())?entry.saved:null;
    sourceCourse=id; sourceName=(id===courseId?currentCourseName():'')||(typeof entry.name==='string'?entry.name:'');
  }
  function restore() {
    const c=readCache(); if(!c)return;
    const day=athensDay();
    // Prefer the course's own valid schedule, then the most recently read active schedule.
    const ids=Object.keys(c.courses).filter(id=>/^\d+$/.test(id)).sort((a,b)=>(c.courses[b]?.saved||0)-(c.courses[a]?.saved||0)||Number(b===c.last)-Number(a===c.last));
    if(courseId&&ids.includes(courseId)){ids.splice(ids.indexOf(courseId),1);ids.unshift(courseId);}
    for(const id of ids){
      try {const entry=c.courses[id]; const rows=validate(entry.rows); if(activeOn(rows,day)){applyEntry(id,entry);return;}} catch {}
    }
  }
  refreshCachedCourseName();
  restore();
  rememberCourseLabels();
  // Minimal ZIP reader for standard XLSX (no external dependencies).
  async function unzip(buffer) {
    const v=new DataView(buffer), bytes=new Uint8Array(buffer), dec=new TextDecoder();
    let end=-1;
    for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--) if(v.getUint32(i,true)===0x06054b50 && i+22+v.getUint16(i+20,true)===bytes.length){end=i;break;}
    if(end<0)throw Error('Μη έγκυρο XLSX');
    const count=v.getUint16(end+10,true); let pos=v.getUint32(end+16,true); const files=new Map();
    if(count>1000)throw Error('Μεγάλο XLSX');
    for(let i=0;i<count;i++){
      if(v.getUint32(pos,true)!==0x02014b50)throw Error('ZIP directory');
      const flags=v.getUint16(pos+8,true), method=v.getUint16(pos+10,true), size=v.getUint32(pos+20,true), outSize=v.getUint32(pos+24,true), nl=v.getUint16(pos+28,true), ex=v.getUint16(pos+30,true), co=v.getUint16(pos+32,true), off=v.getUint32(pos+42,true);
      const name=dec.decode(bytes.subarray(pos+46,pos+46+nl)); pos+=46+nl+ex+co;
      if(!/^xl\/(workbook\.xml|sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/.test(name))continue;
      if(flags&1 || outSize>2000000 || v.getUint32(off,true)!==0x04034b50)throw Error('Μη υποστηριζόμενο ZIP');
      const start=off+30+v.getUint16(off+26,true)+v.getUint16(off+28,true);
      if(start+size>bytes.length)throw Error('ZIP bounds');
      let data=bytes.slice(start,start+size);
      if(method===8)data=new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
      else if(method!==0)throw Error('ZIP compression');
      if(data.length!==outSize)throw Error('ZIP size');
      files.set(name,dec.decode(data));
    }
    return files;
  }
  const xml = text => {const d=new DOMParser().parseFromString(text,'application/xml');if(d.querySelector('parsererror'))throw Error('XML');return d;};
  const tags = (e,n) => [...e.getElementsByTagNameNS('*',n)];
  async function parseXlsx(buffer) {
    const files=await unzip(buffer);
    const wb=xml(files.get('xl/workbook.xml'));
    const is1904=['1','true'].includes(tags(wb,'workbookPr')[0]?.getAttribute('date1904'));
    const shared=files.has('xl/sharedStrings.xml')?tags(xml(files.get('xl/sharedStrings.xml')),'si').map(e=>tags(e,'t').map(t=>t.textContent).join('')):[];
    const date=v=>{if(!/^\d+$/.test(v)||Number(v)<30000||Number(v)>80000)throw Error('Μη υποστηριζόμενη ημερομηνία Excel');return new Date(Date.UTC(is1904?1904:1899,is1904?0:11,is1904?1:30)+Number(v)*86400000).toISOString().slice(0,10);};
    const candidates=[];
    for(const [name,text] of files){
      if(!name.includes('/worksheets/'))continue;
      const rows=tags(xml(text),'row').map(row=>{
        const cells={};for(const c of tags(row,'c')){const col=c.getAttribute('r')?.match(/^[A-Z]+/)?.[0]; const raw=tags(c,'v')[0]?.textContent??'';cells[col]=c.getAttribute('t')==='s'?shared[Number(raw)]:c.getAttribute('t')==='inlineStr'?tags(c,'t').map(t=>t.textContent).join(''):raw;}return cells;
      });
      const header=rows.findIndex(r=>norm(r.A).includes('εβδομαδ')&&norm(r.B).includes('απο')&&norm(r.C).includes('εως'));
      if(header<0)continue;
      const result=[];
      for(const r of rows.slice(header+1)){
        if(!r.A&&!r.B&&!r.C)continue;
        const label=norm(r.A).trim(); const n=/^\d+$/.test(label)?Number(label):/διακοπ/.test(label)?0:null;
        if(n===null)throw Error('Άγνωστη γραμμή χρονοδιαγράμματος');
        result.push([n,date(r.B),date(r.C),n===0?String(r.A):'']);
      }
      candidates.push(validate(result));
    }
    if(candidates.length!==1)throw Error('Δεν βρέθηκε μοναδικό χρονοδιάγραμμα');
    return candidates[0];
  }
  // Only inspect Moodle file resources and direct XLSX links from the course content.
  const MAX_FILE = 3000000, MAX_RESOURCES = 60;
  const isXlsx = u => /\.xlsx$/i.test(u.pathname);
  function candidatesIn(doc, base) {
    const found=new Map();
    for(const a of doc.querySelectorAll('a[href]')){
      let u; try{u=new URL(a.getAttribute('href'),base);}catch{continue;}
      if(u.origin!==location.origin)continue;
      const direct=u.pathname.includes('/pluginfile.php/')&&isXlsx(u);
      if(!direct && !(u.pathname==='/mod/resource/view.php'&&/^\d+$/.test(u.searchParams.get('id')||'')))continue;
      const label=norm(a.textContent+' '+(a.getAttribute('title')||'')+' '+(a.getAttribute('aria-label')||'')+' '+[...a.querySelectorAll('img[alt]')].map(img=>img.alt).join(' '));
      const priority=/χρονοδιαγραμμ|χρονοπρογραμμα|schedule|timetable/.test(label)?0:direct||/xlsx|excel|υπολογιστικ/.test(label)?1:2;
      // A clearly marked non-Excel file need not be downloaded.
      if(!direct&&priority===2&&/\.(pdf|docx?|pptx?|zip|mp[34]|jpe?g|png)\b/i.test(label))continue;
      u.hash=''; if(!direct)u.search='?id='+u.searchParams.get('id');
      const old=found.get(u.href); if(!old||priority<old.priority)found.set(u.href,{url:u.href,priority});
    }
    return [...found.values()].sort((a,b)=>a.priority-b.priority);
  }
  async function fetchLocal(url, signal) {
    const u=new URL(url,location.href);if(u.origin!==location.origin)throw Error('Εξωτερικός σύνδεσμος');
    const r=await fetch(u,{credentials:'same-origin',cache:'no-store',redirect:'follow',signal});
    if(!r.ok||new URL(r.url).origin!==location.origin||new URL(r.url).pathname.includes('/login/')){r.body?.cancel().catch(()=>{});throw Error('Αποτυχία πρόσβασης');}return r;
  }
  async function boundedBytes(r) {
    if(Number(r.headers.get('content-length'))>MAX_FILE){r.body?.cancel().catch(()=>{});throw Error('Μεγάλο αρχείο');}
    if(!r.body){const b=await r.arrayBuffer();if(b.byteLength>MAX_FILE)throw Error('Μεγάλο αρχείο');return b;}
    const reader=r.body.getReader(), chunks=[];let total=0;
    try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>MAX_FILE){await reader.cancel();throw Error('Μεγάλο αρχείο');}chunks.push(value);}}
    finally{reader.releaseLock();}
    const result=new Uint8Array(total);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}return result.buffer;
  }
  async function readWorkbook(r) {
    const type=(r.headers.get('content-type')||'').toLowerCase();
    const disposition=r.headers.get('content-disposition')||'';
    const likely=isXlsx(new URL(r.url))||/\.xlsx(?:["';\s]|$)/i.test(disposition)||/spreadsheetml|octet-stream|application\/zip/.test(type)||!type;
    if(!likely){r.body?.cancel().catch(()=>{});return null;}
    try{return await parseXlsx(await boundedBytes(r));}catch{return null;}
  }
  async function inspectResource(candidate) {
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),12000);
    try{
      const r=await fetchLocal(candidate.url,controller.signal);
      if(!/text\/html|application\/xhtml\+xml/i.test(r.headers.get('content-type')||'')){
        const rows=await readWorkbook(r);return rows?[{rows,resource:candidate.url}]:[];
      }
      const doc=new DOMParser().parseFromString(new TextDecoder().decode(await boundedBytes(r)),'text/html');
      const files=[...new Set([...doc.querySelectorAll('a[href]')].map(a=>{try{return new URL(a.getAttribute('href'),r.url);}catch{return null;}}).filter(u=>u&&u.origin===location.origin&&u.pathname.includes('/pluginfile.php/')&&isXlsx(u)).map(u=>u.href))];
      if(files.length>12)throw Error('Πολλά αρχεία Excel');
      const results=[];
      for(const url of files){try{const rows=await readWorkbook(await fetchLocal(url,controller.signal));if(rows)results.push({rows,resource:candidate.url});}catch{}}
      return results;
    }finally{clearTimeout(timer);}
  }
  const sameDates = rows => JSON.stringify(rows.map(r=>r.slice(0,3)));
  function uniqueSchedule(found, day) {
    const current=found.filter(x=>activeOn(x.rows,day));
    const pool=current.length?current:found.filter(x=>x.rows[0][1]>day);
    const groups=new Map(pool.map(x=>[sameDates(x.rows),x]));
    return {entry:groups.size===1?[...groups.values()][0]:null, conflict:groups.size>1, active:current.length>0};
  }
  async function sync(force=false) {
    if(!courseId||busy)return;
    // Shared data is not proof that this course has already been checked.
    if(!force&&sourceCourse===courseId&&activeOn(schedule,athensDay()))return;
    const root=document.querySelector('#region-main')||document.querySelector('main')||document;
    const all=candidatesIn(root,location.href), candidates=all.slice(0,MAX_RESOURCES);
    // Briefly remember unsuccessful automatic scans in this browser tab; manual refresh always retries.
    const scanKey='eap-helper-scan-'+courseId, signature=JSON.stringify(candidates.map(x=>x.url));
    if(!force){try{const prev=JSON.parse(sessionStorage.getItem(scanKey)||'null');if(prev?.signature===signature&&Date.now()-prev.at<600000)return;}catch{}}
    if(!candidates.length){source='Δεν βρέθηκε αρχείο χρονοδιαγράμματος στην παρούσα Θ.Ε.';update();return;}
    busy=true;source='Αναζήτηση χρονοδιαγράμματος…';update();
    let found=[], failed=0;
    try{
      const day=athensDay();
      // First try likely files, then unnamed file resources if necessary. Four requests at a time.
      for(const priority of [0,1,2]){
        const group=candidates.filter(x=>x.priority===priority);
        for(let i=0;i<group.length;i+=4){
          const batch=await Promise.allSettled(group.slice(i,i+4).map(inspectResource));
          for(const result of batch){if(result.status==='fulfilled')found.push(...result.value);else failed++;}
        }
        if(priority>=1&&uniqueSchedule(found,day).active)break;
      }
      const {entry,conflict}=uniqueSchedule(found,day);
      if(conflict)source='Βρέθηκαν διαφορετικά χρονοδιαγράμματα στην παρούσα Θ.Ε. Δεν έγινε αντικατάσταση.';
      else if(!entry)source=(all.length>MAX_RESOURCES?'Δεν βρέθηκε συμβατό χρονοδιάγραμμα στα πρώτα '+MAX_RESOURCES+' αρχεία.':failed?'Δεν εντοπίστηκε συμβατό χρονοδιάγραμμα ή ορισμένα αρχεία δεν ήταν προσβάσιμα.':'Δεν βρέθηκε συμβατό χρονοδιάγραμμα στην παρούσα Θ.Ε.');
      else if(!activeOn(entry.rows,day)&&activeOn(schedule,day))source='Βρέθηκε χρονοδιάγραμμα μελλοντικής περιόδου. Διατηρείται το τρέχον.';
      else{
        const name=currentCourseName();
        const saved={rows:entry.rows,saved:Date.now(),resource:entry.resource,name};
        applyEntry(courseId,saved);
        const c=readCache()||{courses:{}};c.courses[courseId]=saved;c.last=courseId;source='';
        try{localStorage.setItem(CACHE,JSON.stringify(c));}catch{source='Το χρονοδιάγραμμα διαβάστηκε, αλλά δεν αποθηκεύτηκε τοπικά.';}
        try{sessionStorage.removeItem(scanKey);}catch{}
        return;
      }
      try{sessionStorage.setItem(scanKey,JSON.stringify({signature,at:Date.now()}));}catch{}
    }catch{source='Αποτυχία αναζήτησης χρονοδιαγράμματος.';}
    finally{busy=false;update();}
  }
  const fmt = new Intl.DateTimeFormat('el-GR',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'});
  const day = s => fmt.format(new Date(s+'T00:00:00Z'));
  const updatedFmt = new Intl.DateTimeFormat('el-GR',{timeZone:'Europe/Athens',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const today = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Athens',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).filter(p=>p.type!=='literal').reduce((a,p)=>(a[p.type]=p.value,a),{});
  const key = () => {const t=today();return `${t.year}-${t.month}-${t.day}`;};
  const style = document.createElement('style');
  style.textContent = `#eap-helper-extra a[href]:hover, #eap-helper-extra a[href]:focus-visible {text-decoration:underline !important;cursor:pointer;} #eap-week-helper{box-sizing:border-box;margin:12px 0 20px;padding:14px 18px;border-radius:8px;background:linear-gradient(110deg,#75136d,#15233e);color:#fff;font:inherit;line-height:1.55;box-shadow:0 2px 6px #0002;border-left:5px solid #61db9a} #eap-week-helper strong{font-size:19px;color:#fff;display:block} #eap-week-helper small{color:#fff;display:block;font-size:13px} #eap-week-helper .eap-source{margin-top:0;font-size:13px;line-height:inherit;color:#d8f8e6;font-weight:400} #eap-week-helper .eap-source-meta{display:flex;align-items:baseline;flex-wrap:wrap;gap:0 12px;font-size:13px;color:#d8f8e6;font-weight:400} #eap-week-helper .eap-source-refresh{appearance:none;background:none;border:0;padding:0;margin:0;color:inherit;font:inherit;line-height:inherit;white-space:nowrap;cursor:pointer;box-shadow:none} #eap-week-helper .eap-source-refresh:hover,#eap-week-helper .eap-source-refresh:focus-visible{text-decoration:underline!important} #eap-week-helper .eap-source-refresh:disabled{opacity:.7;cursor:default} .eap-current-week{outline:3px solid #17894b!important;outline-offset:3px!important;}`;
  document.head.append(style);
  function update(){
    const k=key();
    // A borrowed schedule must never carry over into a different study period.
    if(sourceCourse&&sourceCourse!==courseId&&!activeOn(schedule,k)){schedule=[];lastUpdated=null;sourceCourse=null;sourceName='';restore();}
    const idx=schedule.findIndex(r=>k>=r[1]&&k<=r[2]), cur=schedule[idx];
    let banner=document.getElementById('eap-week-helper');
    if(!banner){
      const target=document.querySelector('#region-main')||document.querySelector('main')||document.querySelector('#page-content');
      if(!target)return;
      banner=document.createElement('aside'); banner.id='eap-week-helper'; banner.setAttribute('aria-label','Τρέχουσα εβδομάδα μελέτης'); target.prepend(banner);
    }
    let title, dates='';
    if(!schedule.length){title="📚 Χρονοδιάγραμμα μελέτης μη διαθέσιμο";dates="Άνοιξε μία Θεματική Ενότητα που διαθέτει χρονοδιάγραμμα Excel.";}else if(cur){
      title=cur[0] ? `📚 Τρέχουσα εβδομάδα μελέτης: ${cur[0]}η από ${schedule.filter(r=>r[0]).length}` : (cur[3] || 'Διακοπές');
      dates=`${day(cur[1])} – ${day(cur[2])}`;
    }else{
      title=k<schedule[0][1]?'Το εξάμηνο δεν έχει αρχίσει':'Το χρονοδιάγραμμα μελέτης έχει ολοκληρωθεί';
      dates=`${day(schedule[0][1])} – ${day(schedule.at(-1)[2])}`;
    }
    banner.replaceChildren();
    for(const [tag,str,cls] of [['strong',title,''],['small',dates,'']]){
      if(!str)continue;const el=document.createElement(tag);el.textContent=str;el.className=cls;banner.append(el);
    }
    const meta=document.createElement('div');meta.className='eap-source';
    const actions=document.createElement('div');actions.className='eap-source-meta';
    if(lastUpdated!==null){const t=document.createElement('time');t.dateTime=new Date(lastUpdated).toISOString();t.textContent='Τελευταία ενημέρωση από Χρονοδιάγραμμα ΘΕ: '+updatedFmt.format(new Date(lastUpdated));t.title='Τελευταία επιτυχής ανάγνωση του Excel (ώρα Ελλάδας)';actions.append(t);}
    else if(schedule.length){actions.append(document.createTextNode('Ενημέρωση από Χρονοδιάγραμμα ΘΕ'));}
    if(courseId){const refresh=document.createElement('button');refresh.type='button';refresh.className='eap-source-refresh';refresh.textContent=busy?'Ανάγνωση…':'↻ Ανανέωση';refresh.title='Αναζήτηση χρονοδιαγράμματος Excel στην παρούσα Θ.Ε.';refresh.setAttribute('aria-label','Ανανέωση χρονοδιαγράμματος Θ.Ε.');refresh.disabled=busy;refresh.onclick=()=>sync(true);actions.append(refresh);}
    if(actions.childNodes.length)meta.append(actions);
    if(sourceCourse&&sourceCourse!==courseId&&schedule.length){const provenance=document.createElement('div');provenance.append(document.createTextNode(courseId?'Κοινό χρονοδιάγραμμα από: ':'Χρονοδιάγραμμα από: '));const a=document.createElement('a');a.href='/course/view.php?id='+encodeURIComponent(sourceCourse);a.textContent=sourceName||'Θ.Ε. '+sourceCourse;a.style.color='inherit';a.style.textDecoration='underline';provenance.append(a);meta.append(provenance);}
    if(source){const msg=document.createElement('div');msg.setAttribute('role','status');msg.textContent=source;meta.append(msg);}
    if(meta.childNodes.length)banner.append(meta);
    document.querySelectorAll('.eap-current-week').forEach(e=>e.classList.remove('eap-current-week'));
    // Best-effort: only mark a uniquely identified Buttons navigation control.
    if(cur?.[0] && document.body.classList.contains('format-buttons')){
      const navs=document.querySelectorAll('#buttonsectioncontainer, .buttonsectioncontainer');
      for(const nav of navs){
        const candidates=[...nav.querySelectorAll('a,button,[role="button"],.buttonsection')].filter(e=>e.textContent.trim()===String(cur[0]));
        const leaf=candidates.filter(e=>!candidates.some(other=>other!==e&&e.contains(other)));
        if(leaf.length===1)leaf[0].classList.add('eap-current-week');
      }
    }
    document.dispatchEvent(new Event('eap-schedule-updated'));
  }
  update();
  sync();
  window.addEventListener('focus',update);
  setInterval(update,60000);

// Shared, page-local calendar reader: both panels use the same request and snapshot.
  const upcomingPath = '/calendar/view.php?view=upcoming&course=1';
  let upcomingSnapshot = null, upcomingPending = null;
  function getUpcomingCalendar(force=false) {
    if(upcomingPending)return upcomingPending;
    if(upcomingSnapshot&&!force)return Promise.resolve(upcomingSnapshot);
    upcomingPending=Promise.resolve().then(async()=>{
      const page=new URL(location.href);
      let doc, base;
      if(!force&&page.pathname==='/calendar/view.php'&&page.searchParams.get('view')==='upcoming'&&page.searchParams.get('course')==='1'&&(document.querySelector('[data-type="event"][data-event-id]')||document.querySelector('.calendar-no-results'))){
        doc=document; base=location.href;
      }else{
        const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),15000);
        try{
          const response=await fetch(upcomingPath,{credentials:'same-origin',cache:'no-store',signal:controller.signal});
          const final=new URL(response.url);
          if(!response.ok||final.origin!==location.origin||final.pathname!=='/calendar/view.php')throw Error('calendar');
          doc=new DOMParser().parseFromString(await response.text(),'text/html');base=response.url;
        }finally{clearTimeout(timer);}
      }
      if(!doc.querySelector('[data-type="event"][data-event-id]')&&!doc.querySelector('.calendar-no-results'))throw Error('format');
      rememberCourseLabels(doc,base);
      upcomingSnapshot={doc,base};
      document.dispatchEvent(new Event('eap-upcoming-updated'));
      return upcomingSnapshot;
    }).finally(()=>{upcomingPending=null;});
    return upcomingPending;
  }

// Calendar panel: refresh without clearing existing events
(function () {
    'use strict';
    const calendar = '/calendar/view.php?view=upcoming&course=1';
    const dateKey = () => {
        const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
            timeZone:'Europe/Athens',year:'numeric',month:'2-digit',day:'2-digit'
        }).formatToParts(new Date()).map(x=>[x.type,x.value]));
        return `${p.year}-${p.month}-${p.day}`;
    };
    const el = (tag, text) => {
        const e = document.createElement(tag);
        if (text) e.textContent = text;
        return e;
    };
    const banner = document.getElementById('eap-week-helper');
    if (!banner || document.getElementById('eap-helper-extra')) return;
    const panel = el('div');
    panel.id = 'eap-helper-extra';
    panel.style.cssText = 'margin:-12px 0 20px;padding:12px 16px;border:1px solid #d5d5df;border-radius:8px;line-height:1.6';
    banner.after(panel);
    const count = el('span');
    const jump = el('button','Μετάβαση στην τρέχουσα εβδομάδα →');
    jump.type = 'button';
    jump.style.cssText = 'margin:0 12px 8px 0;padding:6px 12px;border:0;border-radius:5px;background:#77136e;color:white;cursor:pointer';
    const update = () => {
        const k = dateKey();
        const nextRow = schedule.find(r => r[1] > k);
        const next = nextRow?.[1];
        const days = next ? Math.round((Date.parse(next)-Date.parse(k))/86400000) : 0;
        count.textContent = next ? (nextRow[0] === 0 ? 'Διακοπές' : 'Επόμενη εβδομάδα') + ` σε ${days} ${days===1?'ημέρα':'ημέρες'}.` : '';
        jump.hidden = !document.querySelector('.eap-current-week');
        jump.style.display = jump.hidden ? 'none' : '';
    };
    jump.addEventListener('click', () => {
        const target = document.querySelector('.eap-current-week');
        if (!target) return;
        target.click();
        target.scrollIntoView({block:'center',behavior:'smooth'});
    });
    panel.append(jump,count);
    const details = el('details');
    const summary = el('summary','📅 Επόμενες εργασίες, ΟΣΣ και άλλα γεγονότα');
    summary.style.cssText = 'cursor:pointer;font-weight:bold;margin:6px 0';
    const status = el('span');
    status.setAttribute('role','status');
    const toolbar = el('div');
    toolbar.style.cssText = 'display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 12px;margin:8px 0';
    const list = el('ul');
    list.style.cssText = 'list-style:none;padding:0;margin:8px 0';
    const link = el('a','Πλήρες ημερολόγιο μαθημάτων μου ↗');
    link.href = calendar;
    const refreshLabel = '↻ Ανανέωση γεγονότων';
    const refresh = el('button',refreshLabel);
    refresh.type = 'button';
    refresh.style.cssText = 'font:inherit;min-width:12em';
    refresh.title = 'Ανάκτηση των προσεχών γεγονότων από το ημερολόγιο των μαθημάτων μου';
    toolbar.append(status,refresh);
    details.append(summary,toolbar,list,link);
    panel.append(details);
    let loaded = false, busy = false, lastStatus = '';
    // Keep an on-screen event at the same position if the list changes.
    function updateList(fragment, message) {
        let scroller = list.parentElement;
        while (scroller && scroller !== document.body && scroller !== document.documentElement) {
            if (/(auto|scroll|overlay)/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight) break;
            scroller = scroller.parentElement;
        }
        if (scroller === document.body || scroller === document.documentElement) scroller = null;
        const top = scroller ? scroller.getBoundingClientRect().top + scroller.clientTop : 0;
        const bottom = scroller ? top + scroller.clientHeight : window.innerHeight;
        const oldItems = [...list.children];
        const newItems = [...fragment.children];
        const newIds = new Set(newItems.map(item=>item.dataset.eapEventId));
        const anchor = details.open && oldItems.find(item=>{
            const r = item.getBoundingClientRect();
            return newIds.has(item.dataset.eapEventId) && r.bottom > top && r.top < bottom;
        });
        const oldTop = anchor ? anchor.getBoundingClientRect().top : null;
        // If nothing has changed, leave the original DOM (and focus) intact.
        if (oldItems.length !== newItems.length || oldItems.some((item,i)=>!item.isEqualNode(newItems[i]))) {
            list.replaceChildren(fragment);
        }
        if (status.textContent !== message) status.textContent = message;
        lastStatus = message;
        if (anchor) {
            const replacement = [...list.children].find(item=>item.dataset.eapEventId===anchor.dataset.eapEventId);
            if (replacement) {
                const delta = replacement.getBoundingClientRect().top - oldTop;
                if (Math.abs(delta)>1) {
                    if (scroller) scroller.scrollBy({top:delta,behavior:'instant'});
                    else window.scrollBy({top:delta,behavior:'instant'});
                }
            }
        }
    }
    async function load(force=false) {
        if (busy) return;
        busy = true;
        refresh.disabled = true;
        refresh.textContent = '↻ Ανανέωση…';
        if (!loaded) status.textContent = 'Ανάγνωση ημερολογίου μαθημάτων…';
        try {
            const {doc} = await getUpcomingCalendar(force);
            const events = [...doc.querySelectorAll('[data-type="event"][data-event-id]')];
            if (!events.length) {
                if (!doc.querySelector('.calendar-no-results')) throw Error('format');
                updateList(document.createDocumentFragment(),'Δεν βρέθηκαν προσεχή γεγονότα στο ημερολόγιο των μαθημάτων μου.');
                loaded = true;
                return;
            }
            const seen = new Set();
            const rows = [];
            const dateFmt = new Intl.DateTimeFormat('el-GR', {
                timeZone:'Europe/Athens', weekday:'long', day:'numeric', month:'long', year:'numeric'
            });
            const dayKey = date => {
                const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
                    timeZone:'Europe/Athens', year:'numeric', month:'2-digit', day:'2-digit'
                }).formatToParts(date).map(x=>[x.type,x.value]));
                return `${p.year}-${p.month}-${p.day}`;
            };
            for (const event of events) {
                const id = event.dataset.eventId;
                if (seen.has(id)) continue;
                seen.add(id);
                const name = event.dataset.eventTitle || event.querySelector('h3.name')?.textContent?.trim();
                if (!name) continue;
                const header = event.querySelector('.card-header');
                const date = header?.querySelector('.date');
                const anchor = date?.querySelector('a[href*="time="]');
                const raw = anchor ? new URL(anchor.getAttribute('href'), location.origin).searchParams.get('time') : null;
                const stamp = raw && /^\d+$/.test(raw) ? Number(raw)*1000 : NaN;
                const valid = Number.isFinite(stamp) && !Number.isNaN(new Date(stamp).getTime());
                const dateText = valid ? dateFmt.format(new Date(stamp)) : (anchor?.textContent.trim() || '');
                const hours = date?.textContent.match(/\b\d{1,2}:\d{2}\b/g) || [];
                const days = valid ? Math.round((Date.parse(dayKey(new Date(stamp)))-Date.parse(dateKey()))/86400000) : null;
                if (days !== null && days < 0) continue;
                const courseAnchor = event.querySelector('a[href*="/course/view.php"]');
                let eventCourseId=event.dataset.courseId || event.dataset.courseid || '';
                const courseHref=courseAnchor?.getAttribute('href');
                if(courseHref)try{
                    const u=new URL(courseHref,location.href);
                    if(u.origin===location.origin && u.pathname==='/course/view.php')eventCourseId=u.searchParams.get('id')||eventCourseId;
                }catch{}
                const course = eventCourseId || courseAnchor ? friendlyCourseLabel(eventCourseId,courseAnchor?.textContent?.trim()) : '';
                const type = /ΕΞΕΤΑΣ/i.test(name) ? ['Εξέταση','#a65d13'] : /ΕΡΓΑΣΤΗΡ/i.test(name) ? ['Εργαστήριο','#287950'] : /ΟΣΣ/i.test(name) ? ['ΟΣΣ','#285e87'] : /οφείλεται/i.test(name) || header?.querySelector('img[src*="/assign/"]') ? ['Εργασία','#77136e'] : ['Γεγονός','#666'];
                rows.push({id, name, stamp:valid?stamp:Infinity, dateText, hours, days, course, type, anchor});
            }
            rows.sort((a,b)=>a.stamp-b.stamp);
            const fragment = document.createDocumentFragment();
            for (const row of rows) {
                const item = el('li');
                item.dataset.eapEventId = row.id;
                item.style.cssText=`border-left:4px solid ${row.type[1]};padding:8px 12px;margin:0 0 8px;border-bottom:1px solid #ddd`;
                const label = el('div',row.type[0]);
                label.style.cssText=`color:${row.type[1]};font-weight:bold;font-size:12px`;
                item.append(label,el('strong',row.name));
                if (row.course) item.append(el('div',row.course));
                const dateLine = el('div');
                if (row.anchor) {
                    const url = new URL(row.anchor.getAttribute('href'),location.origin);
                    if (url.origin === location.origin && url.pathname === '/calendar/view.php') {
                        const a = el('a',row.dateText || 'Ημερολόγιο'); a.href=url.href; dateLine.append(a);
                    } else dateLine.append(document.createTextNode(row.dateText));
                } else dateLine.append(document.createTextNode(row.dateText || 'Ημερομηνία μη διαθέσιμη'));
                if (row.hours.length) dateLine.append(document.createTextNode(' · '+row.hours.join('–')));
                item.append(dateLine);
                if (row.days !== null) {
                    const remaining = el('div',row.days===0?'Σήμερα':row.days===1?'Αύριο':`Σε ${row.days} ημέρες`);
                    remaining.style.fontWeight='bold'; item.append(remaining);
                }
                fragment.append(item);
            }
            updateList(fragment, rows.length === 1 ? '1 προσεχές γεγονός από το ημερολόγιο των μαθημάτων μου.' : rows.length ? `${rows.length} προσεχή γεγονότα από το ημερολόγιο των μαθημάτων μου.` : 'Δεν βρέθηκαν προσεχή γεγονότα στο ημερολόγιο των μαθημάτων μου.');
            loaded = true;
        } catch (e) {
            status.textContent = loaded ? `${lastStatus} Η ανανέωση απέτυχε· διατηρούνται τα προηγούμενα δεδομένα.` : 'Δεν ήταν δυνατή η ανάγνωση. Δοκίμασε Ανανέωση ή άνοιξε το ημερολόγιο.';
        } finally {
            busy = false;
            refresh.textContent = refreshLabel;
            refresh.disabled = false;
        }
    }
    details.addEventListener('toggle',()=>{if(details.open && !loaded) load();});
    refresh.addEventListener('click',()=>load(true));
    document.addEventListener('eap-upcoming-updated',()=>{if(loaded&&!busy)load();});
    update();
    document.addEventListener('eap-schedule-updated',update);
    window.addEventListener('focus',update);
    setInterval(update,60000);
})();

// Activity and calendar search
(function () {
    'use strict';
    const pageURL = new URL(location.href);
    const coursePage = pageURL.pathname === '/course/view.php';
    const calendarPage = pageURL.pathname === '/calendar/view.php';
    const dashboardPage = ['/', '/index.php', '/my', '/my/', '/my/index.php'].includes(pageURL.pathname);
    if ((!coursePage && !calendarPage && !dashboardPage) || document.getElementById('eap-activity-search-beta')) return;
    const courseId = coursePage ? pageURL.searchParams.get('id') : null;
    const calendarPath = '/calendar/view.php?view=upcoming&course=1';
    const courseName = coursePage ? document.title.replace(/^(?:Μάθημα|Course):\s*/iu, '').trim() : '';

    const root = document.querySelector('#region-main') || document.querySelector('main') || document.querySelector('#page-content');
    if (!root) return;
    const clean = s => String(s || '').replace(/\s+/gu, ' ').trim();
    const norm = s => clean(s).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/ς/g, 'σ');
    const categories = new Map([
        ['assign', ['Εργασίες', '#77136e', 'Ανάθεση εργασίας']],
        ['exam', ['Εξετάσεις', '#a65d13', 'Ανάθεση εργασίας']],
        ['oss', ['ΟΣΣ', '#285e87', '']],
        ['workshop', ['Εργαστήρια', '#287950', '']],
        ['quiz', ['Κουίζ', '#a65d13', 'Κουίζ']],
        ['forum', ['Συζητήσεις – Φόρουμ', '#285e87', 'Φόρουμ']],
        ['lesson', ['Μαθήματα', '#285e87', 'Μάθημα']],
        ['feedback', ['Ανατροφοδότηση', '#285e87', 'Ανατροφοδότηση']],
        ['resource', ['Αρχεία', '#287950', 'Αρχείο']],
        ['folder', ['Φάκελοι', '#287950', 'Φάκελος']],
        ['url', ['Σύνδεσμοι', '#64748b', 'Διεύθυνση URL']],
        ['page', ['Σελίδες', '#287950', 'Σελίδα']],
        ['book', ['Βιβλία', '#287950', 'Βιβλίο']],
        ['assigncertificate', ['Βεβαιώσεις', '#64748b', 'Βεβαίωση ΓΕ']],
        ['customcert', ['Πιστοποιητικά', '#64748b', 'Προσαρμοσμένο πιστοποιητικό']],
        ['event', ['Άλλα γεγονότα', '#777', '']],
        ['other', ['Άλλες δραστηριότητες', '#777', '']]
    ]);
    function collect() {
        if (!coursePage) return {groups:new Map(),rows:[]};
        const sections = [...root.querySelectorAll('[id^="section-"]')].filter(s => /^section-\d+$/.test(s.id));
        const groups = new Map(), rows = new Map();
        for (const section of sections) {
            const heading = [...section.querySelectorAll('h2,h3,h4')].map(h => clean(h.textContent)).find(t => /^(εβδομαδα|week)\s+\d+$/u.test(norm(t)));
            const number = heading ? Number(heading.match(/\d+$/)[0]) : null;
            const label = number !== null ? 'Εβδομάδα ' + number : section.id === 'section-0' ? 'Γενική ενότητα' : section.id === 'section-1' && [...section.querySelectorAll('h2,h3,h4')].some(h => norm(h.textContent) === 'πληροφοριεσ') ? 'Πληροφορίες' : 'Ενότητα ' + section.id.slice(8);
            const key = number !== null ? 'week-' + number : section.id;
            groups.set(key, {key, label, order:number === null ? Number(section.id.slice(8)) - 1000 : number});
            for (const a of section.querySelectorAll('a[href*="/mod/"][href*="/view.php"]')) {
                if (a.closest('[id^="section-"]') !== section) continue;
                let u; try {u = new URL(a.href, location.href);} catch {continue;}
                const match = u.pathname.match(/^\/mod\/([a-z][a-z0-9_]*)\/view\.php$/);
                const id = u.searchParams.get('id');
                if (u.origin !== location.origin || !match || !/^\d+$/.test(id || '') || u.searchParams.has('action') || u.hash) continue;
                const mod = match[1];
                let title = clean(a.textContent);
                if (!title) continue;
                const suffix = categories.get(mod)?.[2];
                if (suffix && title.endsWith(' ' + suffix)) title = title.slice(0, -suffix.length - 1).trim();
                if (!title) continue;
                const type = mod === 'assign' && /(?:^|\s)(?:τελικη\s+|επαναληπτικη\s+)?εξεταση(?:\s|$)/u.test(norm(title)) ? 'exam' : categories.has(mod) ? mod : 'other';
                const rowKey = mod + ':' + id;
                if (!rows.has(rowKey)) rows.set(rowKey, {title, type, source:'course', groups:new Set(), url:u.origin + u.pathname + '?id=' + id});
                rows.get(rowKey).groups.add(key);
            }
        }
        return {groups, rows:[...rows.values()]};
    }
    const dateFmt = new Intl.DateTimeFormat('el-GR',{timeZone:'Europe/Athens', day:'2-digit', month:'2-digit', year:'numeric'});
    const dateKey = d => Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Athens',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d).map(x=>[x.type,x.value]));
    const day = d => {const p=dateKey(d);return `${p.year}-${p.month}-${p.day}`;};
    const courseCode = name => norm(name).match(/^([\p{L}]{1,12})\s*[-–]?\s*(\d{1,5}[\p{L}]?)(?=\s|:|[-–—]|$)/u)?.slice(1).join('') || '';
    function localURL(raw, base=location.href) {
        try {const u=new URL(raw,base); return u.origin===location.origin && /^https?:$/.test(u.protocol) ? u : null;} catch {return null;}
    }
    function eventType(name, event) {
        const n=norm(name);
        if (/εξετασ|\bexam\b/u.test(n)) return 'exam';
        if (/εργαστηρ|\bworkshop\b/u.test(n)) return 'workshop';
        if (/οσσ/u.test(n)) return 'oss';
        if (/οφειλεται|εργασι|\bassignment\b/u.test(n) || event.querySelector('img[src*="/assign/"]') || event.dataset.modulename==='assign') return 'assign';
        if (event.dataset.modulename==='quiz') return 'quiz';
        return 'event';
    }
    function parseUpcoming(doc, base) {
        rememberCourseLabels(doc,base);
        const events=[...doc.querySelectorAll('[data-type="event"][data-event-id]')];
        if (!events.length && !doc.querySelector('.calendar-no-results')) throw Error('Μη αναγνωρίσιμη μορφή ημερολογίου');
        const rows=new Map();
        for (const event of events) {
            const id=event.dataset.eventId;
            const title=clean(event.dataset.eventTitle || event.querySelector('h3.name')?.textContent);
            if (!id || !title || rows.has(id)) continue;
            const header=event.querySelector('.card-header');
            const date=header?.querySelector('.date');
            const anchor=date?.querySelector('a[href*="time="]');
            const dateURL=anchor && localURL(anchor.getAttribute('href'),base);
            const raw=dateURL?.searchParams.get('time');
            const stamp=raw && /^\d+$/.test(raw) ? Number(raw)*1000 : NaN;
            const valid=Number.isFinite(stamp) && !Number.isNaN(new Date(stamp).getTime());
            if(valid && day(new Date(stamp)) < day(new Date())) continue;
            const dateText=valid ? dateFmt.format(new Date(stamp)) : clean(anchor?.textContent);
            const hours=(date?.textContent.match(/\b\d{1,2}:\d{2}\b/g)||[]).join('–');
            const courseLink=[...event.querySelectorAll('a[href*="/course/view.php"]')].find(a=>{
                const u=localURL(a.getAttribute('href'),base);return u?.pathname==='/course/view.php' && /^\d+$/.test(u.searchParams.get('id')||'') && u.searchParams.get('id')!=='1';
            });
            const linkId=courseLink ? localURL(courseLink.getAttribute('href'),base)?.searchParams.get('id') : '';
            const attrId=event.dataset.courseId || event.dataset.courseid || '';
            const cid=linkId || (/^\d+$/.test(attrId) && attrId!=='1' ? attrId : '');
            const cname=clean(courseLink?.textContent || event.dataset.courseName || event.dataset.coursename);
            const matchCode=courseCode(courseName), eventCode=courseCode(cname);
            // Do not assign a calendar event to a course without positive evidence.
            const titleCode=matchCode && norm(title).split(/[^\p{L}\p{N}]+/u).some((part,i,parts)=>part===matchCode || part+(parts[i+1]||'')===matchCode);
            const belongs=cid ? cid===courseId : !!(matchCode && (eventCode===matchCode || (!eventCode && titleCode))) || !!(cname && norm(cname)===norm(courseName));
            if(coursePage && !belongs && (cid || cname)) continue;
            rows.set(id,{title,type:eventType(title,event),source:'calendar',groups:new Set(),
                course:belongs && coursePage ? friendlyCourseLabel(courseId,courseName) : friendlyCourseLabel(cid,cname),
                courseKey:cid ? 'course-'+cid : belongs && coursePage ? 'course-'+courseId : cname ? 'name-'+norm(cname) : 'unknown',
                dateText,hours,stamp:valid?stamp:Infinity,
                url:dateURL?.pathname==='/calendar/view.php' ? dateURL.href : new URL(calendarPath,location.origin).href});
        }
        if(events.length && !rows.size && !coursePage && !events.some(e=>clean(e.dataset.eventTitle||e.querySelector('h3.name')?.textContent))) throw Error('Δεν αναγνωρίστηκαν τίτλοι γεγονότων');
        return [...rows.values()].sort((a,b)=>a.stamp-b.stamp);
    }
    function mount() {
        if (document.getElementById('eap-activity-search-beta')) return true;
        const panel = document.getElementById('eap-helper-extra');
        if (!panel) return false;
        if (document.getElementById('eap-search-test')) return true; // avoid overlapping console prototype
        const initial = collect();
        if (coursePage && !initial.groups.size) return false;
        const el = (tag, text, cls) => {const e=document.createElement(tag); if(text)e.textContent=text; if(cls)e.className=cls; return e;};
        const details=el('details'); details.id='eap-activity-search-beta';
        const summary=el('summary','🔎 Αναζήτηση εργασιών, δραστηριοτήτων και γεγονότων');
        const search=el('input'); search.type='search'; search.placeholder='Αναζήτηση λέξης ή φράσης…'; search.setAttribute('aria-label','Λέξη ή φράση αναζήτησης'); search.spellcheck=false; search.autocomplete='off';
        const filters=el('div','','eap-search-filters');
        const category=el('select'); category.setAttribute('aria-label','Κατηγορία δραστηριότητας');
        const week=el('select'); week.setAttribute('aria-label',coursePage?'Πηγή, εβδομάδα ή ενότητα':'Θεματική Ενότητα');
        filters.append(search,category,week);
        const toolbar=el('div','','eap-search-toolbar');
        const status=el('span'); status.setAttribute('role','status'); status.setAttribute('aria-live','polite');
        const reset=el('button','↻ Καθαρισμός φίλτρων'); reset.type='button'; toolbar.append(status,reset);
        const list=el('div','','eap-search-results');
        list.setAttribute('role','list'); list.setAttribute('aria-label','Αποτελέσματα αναζήτησης');
        const note=el('div','','eap-search-note');
        const calendarStatus=el('span'); calendarStatus.setAttribute('role','status');
        const refreshCalendar=el('button','↻ Ανανέωση ημερολογίου'); refreshCalendar.type='button';
        const fullCalendar=el('a','Πλήρες ημερολόγιο ↗'); fullCalendar.href=calendarPath;
        note.append(calendarStatus,refreshCalendar,fullCalendar);
        const style=el('style'); style.id='eap-activity-search-beta-css';
        style.textContent=`
#eap-activity-search-beta {border-top:1px solid #d5d5df;margin-top:12px;padding-top:10px;min-width:0;container-type:inline-size;container-name:eap-search}
#eap-activity-search-beta summary {font-weight:bold;cursor:pointer;margin:0}
#eap-activity-search-beta input[type="search"] {display:block!important;width:100%!important;max-width:none!important;box-sizing:border-box;height:38px;min-width:0!important;padding:7px 10px;border:1px solid #c8c8d2;border-radius:5px;margin:0!important;font:inherit;background:inherit;color:inherit}
#eap-activity-search-beta .eap-search-filters {display:grid;grid-template-columns:minmax(0,1.4fr) repeat(2,minmax(0,1fr));gap:8px;align-items:center;margin-top:12px}
#eap-activity-search-beta select {width:100%!important;max-width:100%;min-width:0!important;box-sizing:border-box;height:38px;min-height:38px;border:1px solid #c8c8d2;border-radius:5px;padding:5px 8px;font:inherit;background-color:inherit;color:inherit;margin:0!important}
#eap-activity-search-beta input:focus,#eap-activity-search-beta select:focus {border-color:#77136e!important;box-shadow:0 0 0 2px #77136e20!important;outline:1px solid #77136e}
#eap-activity-search-beta .eap-search-toolbar {display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:4px 12px;margin:8px 0 4px;line-height:1.5;font-size:13px}
#eap-activity-search-beta [role="status"] {opacity:.85}
#eap-activity-search-beta button {appearance:none;background:transparent!important;color:#77136e!important;border:0!important;box-shadow:none!important;padding:4px 0!important;margin:0!important;font:inherit!important;font-weight:normal!important;cursor:pointer}
#eap-activity-search-beta button:hover,#eap-activity-search-beta button:focus-visible {text-decoration:underline!important}
#eap-activity-search-beta .eap-search-results {max-height:420px;overflow-y:auto;overflow-wrap:anywhere;padding-right:6px}
#eap-activity-search-beta .eap-search-result {padding:6px 12px;margin:6px 0;border-left:4px solid var(--eap-type-color,#777)}
#eap-activity-search-beta .eap-search-meta {font-size:12px;opacity:.85}
#eap-activity-search-beta a {color:#77136e!important;font-weight:500;overflow-wrap:anywhere}
#eap-activity-search-beta a:hover,#eap-activity-search-beta a:focus-visible {text-decoration:underline!important}
#eap-activity-search-beta .eap-search-note {font-size:12px;opacity:.85;margin-top:6px;display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px}
@container eap-search (max-width:760px) {
 #eap-activity-search-beta .eap-search-filters {grid-template-columns:repeat(2,minmax(0,1fr))}
 #eap-activity-search-beta input[type="search"] {grid-column:1/-1}
}
@container eap-search (max-width:480px) {
 #eap-activity-search-beta .eap-search-filters {grid-template-columns:minmax(0,1fr)}
}
@supports not (container-type:inline-size) {
 @media (max-width:800px) {#eap-activity-search-beta .eap-search-filters {grid-template-columns:repeat(2,minmax(0,1fr))} #eap-activity-search-beta input[type="search"] {grid-column:1/-1}}
 @media (max-width:520px) {#eap-activity-search-beta .eap-search-filters {grid-template-columns:minmax(0,1fr)}}
}
@media (prefers-color-scheme:dark) {#eap-activity-search-beta a,#eap-activity-search-beta button {color:inherit!important;text-decoration:underline} }
`;
        document.head.append(style);
        let data=initial, events=[], loaded=false, loading=false, failed=false;
        function options(select, label, entries) {
            const selected=select.value;
            const first=el('option',label); first.value='';
            select.replaceChildren(first);
            for(const [key,label] of entries){const opt=el('option',label);opt.value=key;select.append(opt);}
            if([...select.options].some(o=>o.value===selected))select.value=selected;
        }
        const combined=()=>[...data.rows,...events];
        function refreshData(){
            rememberCourseLabels();
            data=collect();
            const used=new Set(combined().map(r=>r.type));
            options(category,'Όλες οι κατηγορίες',[...categories].filter(([key])=>used.has(key)).map(([key,v])=>[key,v[0]]));
            if(coursePage) {
                options(week,'Όλες οι πηγές', [['activities','Δραστηριότητες Θ.Ε.'],['calendar','Ημερολόγιο'],... [...data.groups.values()].sort((a,b)=>a.order-b.order).map(g=>[g.key,g.label])]);
            } else {
                const courses=new Map(events.map(r=>[r.courseKey,r.course]));
                options(week,'Όλες οι Θ.Ε.',[...courses].sort((a,b)=>a[1].localeCompare(b[1],'el')));
            }
            render();
        }
        function render(){
            const query=norm(search.value), all=combined();
            const found=all.filter(r=>{
                if(category.value && r.type!==category.value)return false;
                if(week.value) {
                    if(!coursePage && r.courseKey!==week.value)return false;
                    if(coursePage && (week.value==='activities' ? r.source!=='course' : week.value==='calendar' ? r.source!=='calendar' : !r.groups.has(week.value)))return false;
                }
                const labels=[...r.groups].map(k=>data.groups.get(k)?.label||'').join(' ');
                return norm([r.title,categories.get(r.type)[0],labels,r.course,r.dateText,r.hours,r.source==='calendar'?'Ημερολόγιο':''].filter(Boolean).join(' ')).includes(query);
            });
            status.textContent=`${found.length} από ${all.length} αποτελέσματα`;
            const frag=document.createDocumentFragment();
            for(const row of found){
                const item=el('div','','eap-search-result');item.setAttribute('role','listitem');
                item.style.setProperty('--eap-type-color',categories.get(row.type)[1]);
                const labels=[...row.groups].map(k=>data.groups.get(k)?.label||'').join(', ');
                const meta=el('div',row.source==='calendar' ? [row.course,'Ημερολόγιο',row.dateText||'Ημερομηνία μη διαθέσιμη',row.hours,categories.get(row.type)[0]].filter(Boolean).join(' · ') : labels+' · '+categories.get(row.type)[0],'eap-search-meta');
                const link=el('a',row.title+' ↗');link.href=row.url;link.target='_blank';link.rel='noopener noreferrer';
                item.append(meta,link);frag.append(item);
            }
            if(!found.length)frag.append(el('div',loading?'Ανάγνωση ημερολογίου…':failed?'Δεν βρέθηκαν αποτελέσματα στα διαθέσιμα δεδομένα.':'Δεν βρέθηκαν αποτελέσματα.'));
            list.replaceChildren(frag);list.scrollTop=0;
            calendarStatus.textContent=loading?'Ανάγνωση προσεχών γεγονότων…':failed?(loaded?'Η ανανέωση απέτυχε. Διατηρούνται τα προηγούμενα γεγονότα.':'Δεν ήταν δυνατή η ανάγνωση του ημερολογίου.'):loaded?'Τίτλοι δραστηριοτήτων και προσεχή γεγονότα.':'Η αναζήτηση αφορά τους τίτλους και τα προσεχή γεγονότα.';
            if(loaded && !coursePage && !failed && !loading)calendarStatus.textContent='Αναζήτηση στα προσεχή γεγονότα των μαθημάτων.';
            refreshCalendar.disabled=loading;
        }
        async function loadCalendar(force=false,reuse=false){
            if(loading || (loaded && !force && !reuse))return;
            loading=true;failed=false;render();
            try {
                const {doc,base}=await getUpcomingCalendar(force);
                events=parseUpcoming(doc,base);
                loaded=true;
            } catch {failed=true;}
            finally {loading=false;refreshData();}
        }
        search.addEventListener('input',render);category.addEventListener('change',render);week.addEventListener('change',render);
        reset.addEventListener('click',()=>{search.value=category.value=week.value='';render();search.focus();});
        refreshCalendar.addEventListener('click',()=>loadCalendar(true));
        document.addEventListener('eap-upcoming-updated',()=>{if(loaded&&!loading)loadCalendar(false,true);});
        details.addEventListener('toggle',()=>{if(details.open){refreshData();loadCalendar();}});
        details.append(summary,filters,toolbar,list,note);panel.append(details);
        refreshData();
        return true;
    }
    // Search is mounted independently of whether a compatible study schedule is available.
    if (!mount()) {
        const observer=new MutationObserver(()=>{if(mount())observer.disconnect();});
        observer.observe(root,{childList:true,subtree:true});
        setTimeout(()=>observer.disconnect(),10000);
    }
})();

})();
