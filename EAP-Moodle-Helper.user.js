// ==UserScript==
// @name         EAP Moodle Helper
// @namespace    eap-local-helper
// @version      3.0.3
// @description  Αυτόματο χρονοδιάγραμμα μελέτης και ημερολόγιο ΕΑΠ
// @match        https://courses.eap.gr/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
(function () {
  'use strict';
  // Shared state: only validated schedules are accepted.
  const CACHE = 'eap-helper-schedule-v3';
  const courseId = location.pathname === '/course/view.php' ? new URLSearchParams(location.search).get('id') : null;
  let schedule = [], source = '', lastUpdated = null, busy = false;
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
  function restore() {
    const c=readCache(); const entry=courseId ? c?.courses[courseId] : c?.courses[c.last];
    if(!entry)return;
    try {schedule=validate(entry.rows); lastUpdated=Number.isFinite(entry.saved)&&Number.isFinite(new Date(entry.saved).getTime())?entry.saved:null;} catch {}
  }
  restore();
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
  async function fetchLocal(url) {
    const u=new URL(url,location.href);if(u.origin!==location.origin)throw Error('Εξωτερικός σύνδεσμος');
    const r=await fetch(u,{credentials:'same-origin',cache:'no-store',redirect:'follow'});
    if(!r.ok||new URL(r.url).origin!==location.origin||new URL(r.url).pathname.includes('/login/'))throw Error('Αποτυχία πρόσβασης');return r;
  }
  async function sync(force=false) {
    if(!courseId||busy)return;
    // Fetch once per course; subsequent reads require explicit user action.
    if(!force&&schedule.length)return;
    const links=[...document.querySelectorAll('a[href]')].filter(a=>/χρονοδιαγραμμα\s*θ\s*\.?\s*ε/i.test(norm(a.textContent))&&new URL(a.href).pathname==='/mod/resource/view.php');
    const urls=[...new Set(links.map(a=>a.href))];
    if(urls.length!==1){source='Δεν εντοπίστηκε μοναδικό χρονοδιάγραμμα Θ.Ε.'+(schedule.length?' · Τοπικό αντίγραφο':'');update();return;}
    busy=true;source='Ανάκτηση χρονοδιαγράμματος ΕΑΠ…';update();
    try {
      const r=await fetchLocal(urls[0]);let file=r;
      if(/text\/html/i.test(r.headers.get('content-type')||'')){
        const doc=new DOMParser().parseFromString(await r.text(),'text/html');
        const files=[...new Set([...doc.querySelectorAll('a[href]')].map(a=>new URL(a.getAttribute('href'),r.url)).filter(u=>u.origin===location.origin&&u.pathname.includes('/pluginfile.php/')&&/\.xlsx$/i.test(u.pathname)).map(u=>u.href))];
        if(files.length!==1)throw Error('Δεν βρέθηκε μοναδικό XLSX');file=await fetchLocal(files[0]);
      }
      const buffer=await file.arrayBuffer();if(buffer.byteLength>3000000)throw Error('Μεγάλο αρχείο');
      schedule=await parseXlsx(buffer);
      lastUpdated=Date.now();
      const c=readCache()||{courses:{}};c.courses[courseId]={rows:schedule,saved:lastUpdated,resource:urls[0]};c.last=courseId;
      source='';
      try{localStorage.setItem(CACHE,JSON.stringify(c));}catch{source='Το χρονοδιάγραμμα διαβάστηκε, αλλά δεν αποθηκεύτηκε τοπικά.';}
    }catch(e){source='Αποτυχία ανάγνωσης: '+e.message+(schedule.length?' · Τοπικό αντίγραφο':'');}
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
    const k=key(), idx=schedule.findIndex(r=>k>=r[1]&&k<=r[2]), cur=schedule[idx];
    let banner=document.getElementById('eap-week-helper');
    if(!banner){
      const target=document.querySelector('#region-main')||document.querySelector('main')||document.querySelector('#page-content');
      if(!target)return;
      banner=document.createElement('aside'); banner.id='eap-week-helper'; banner.setAttribute('aria-label','Τρέχουσα εβδομάδα μελέτης'); target.prepend(banner);
    }
    let title, dates='';
    if(!schedule.length){title="📚 Χρονοδιάγραμμα μελέτης μη διαθέσιμο";dates="Άνοιξε μία Θεματική Ενότητα για αυτόματη ανάκτηση.";}else if(cur){
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
    if(courseId){const refresh=document.createElement('button');refresh.type='button';refresh.className='eap-source-refresh';refresh.textContent=busy?'Ανάγνωση…':'↻ Ανανέωση';refresh.title='Ανάκτηση και ανάγνωση του επίσημου Excel από το Moodle';refresh.setAttribute('aria-label','Ανανέωση χρονοδιαγράμματος Θ.Ε.');refresh.disabled=busy;refresh.onclick=()=>sync(true);actions.append(refresh);}
    if(actions.childNodes.length)meta.append(actions);
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

// Calendar panel (preserved from 2.1.1)
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
    const status = el('p');
    status.setAttribute('role','status');
    const list = el('ul');
    list.style.cssText = 'padding-left:22px;margin:8px 0';
    const link = el('a','Πλήρες ημερολόγιο Moodle ↗');
    link.href = calendar;
    const refresh = el('button','Ανανέωση');
    refresh.type = 'button';
    refresh.style.marginLeft = '12px';
    details.append(summary,status,list,link,refresh);
    panel.append(details);
    let loaded = false, busy = false;
    async function load() {
        if (busy) return;
        busy = true;
        refresh.disabled = true;
        status.textContent = 'Ανάγνωση ημερολογίου Moodle…';
        list.replaceChildren();
        try {
            const response = await fetch(calendar,{credentials:'same-origin',cache:'no-store'});
            if (!response.ok || new URL(response.url).pathname.includes('/login/')) throw Error('calendar');
            const doc = new DOMParser().parseFromString(await response.text(),'text/html');
            const events = [...doc.querySelectorAll('[data-type="event"][data-event-id]')];
            if (!events.length) {
                status.textContent = doc.querySelector('.calendar-no-results')
                    ? 'Το Moodle δεν εμφανίζει προσεχή γεγονότα στο επιλεγμένο διάστημα.'
                    : 'Δεν αναγνωρίστηκε η μορφή του ημερολογίου. Άνοιξε τον σύνδεσμο παρακάτω.';
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
                const course = event.querySelector('a[href*="/course/view.php"]')?.textContent?.trim();
                const type = /ΕΞΕΤΑΣ/i.test(name) ? ['Εξέταση','#a65d13'] : /ΕΡΓΑΣΤΗΡ/i.test(name) ? ['Εργαστήριο','#287950'] : /ΟΣΣ/i.test(name) ? ['ΟΣΣ','#285e87'] : /οφείλεται/i.test(name) || header?.querySelector('img[src*="/assign/"]') ? ['Εργασία','#77136e'] : ['Γεγονός','#666'];
                rows.push({name, stamp:valid?stamp:Infinity, dateText, hours, days, course, type, anchor});
            }
            rows.sort((a,b)=>a.stamp-b.stamp);
            list.style.cssText='list-style:none;padding:0;margin:8px 0';
            for (const row of rows) {
                const item = el('li');
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
                list.append(item);
            }
            status.textContent = rows.length ? `${rows.length} γεγονότα από το ημερολόγιο του Moodle.` : 'Δεν βρέθηκαν επόμενα γεγονότα.';
            loaded = true;
        } catch (e) {
            status.textContent = 'Δεν ήταν δυνατή η ανάγνωση. Δοκίμασε Ανανέωση ή άνοιξε το ημερολόγιο.';
        } finally {
            busy = false;
            refresh.disabled = false;
        }
    }
    details.addEventListener('toggle',()=>{if(details.open && !loaded) load();});
    refresh.addEventListener('click',load);
    update();
    document.addEventListener('eap-schedule-updated',update);
    window.addEventListener('focus',update);
    setInterval(update,60000);
})();
})();
