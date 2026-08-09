// ═══════════════════════════════════════════════════════════════
// FIREBASE INIT
// ═══════════════════════════════════════════════════════════════
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getDatabase, ref, set, get, onValue, off
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

// ⚠️ GANTI dengan config project Firebase Anda sendiri
// (Firebase Console → Project settings → Your apps → SDK setup and configuration)
const firebaseConfig = {
  apiKey: "AIzaSyBG1wMzXqRDK5fEKfosIvuRUjTQ620s-Go",
  authDomain: "bel-sekolah-otomatis.firebaseapp.com",
  databaseURL: "https://bel-sekolah-otomatis-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "bel-sekolah-otomatis",
};

const fbApp  = initializeApp(firebaseConfig);
const auth   = getAuth(fbApp);
const db     = getDatabase(fbApp);

// ── 4 komplek — id HARUS SAMA PERSIS dengan DEVICE_ID di firmware ──
const KOMPLEK = [
  { id: "komplek1", nama: "Komplek SMA",localIp: "192.168.0.102" },
  { id: "komplek2", nama: "Komplek SMP",localIp: "192.168.0.102" },
  { id: "komplek3", nama: "Komplek Akhwat",localIp: "192.168.0.102" },
  { id: "komplek4", nama: "Komplek MI",localIp: "192.168.0.102" },
];

const OFFLINE_THRESHOLD_MS = 20000;

// ═══════════════════════════════════════════════════════════════
// LOGIN
// ═══════════════════════════════════════════════════════════════
// Sesi login BERTAHAN saat halaman di-refresh (tidak perlu klik "Masuk" lagi
// selama masih aktif), TAPI otomatis logout kalau tidak ada aktivitas sama
// sekali selama IDLE_TIMEOUT_MS — jadi kalau ditinggal beberapa menit,
// saat kembali harus login ulang.
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;   // 5 menit tanpa aktivitas → logout otomatis
const LAST_ACTIVE_KEY = 'belOnline_lastActive';
 
function markActive(){
  try{ localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now())); }catch(e){}
}
function getLastActive(){
  try{ return parseInt(localStorage.getItem(LAST_ACTIVE_KEY)||'0',10); }catch(e){ return 0; }
}
function isIdleExpired(){
  const last = getLastActive();
  return last>0 && (Date.now()-last) > IDLE_TIMEOUT_MS;
}
 
// Catat aktivitas pengguna (klik/ketik/geser) supaya penghitung idle ke-reset
['click','keydown','mousemove','touchstart'].forEach(evt=>
  document.addEventListener(evt, markActive, {passive:true})
);
 
// Cek berkala selagi tab tetap terbuka — kalau idle terlalu lama, paksa logout
setInterval(()=>{
  if(auth.currentUser && isIdleExpired()) signOut(auth);
}, 15000);
 
setPersistence(auth, browserLocalPersistence);
 
window.doLogin = async function () {
  const email = document.getElementById('loginEmail').value.trim();
  const pass  = document.getElementById('loginPass').value;
  const errEl = document.getElementById('loginErr');
  errEl.textContent = '';
  try {
    await signInWithEmailAndPassword(auth, email, pass);
    markActive();
  } catch (e) {
    errEl.textContent = 'Login gagal — cek email/password.';
  }
};
 
window.doLogout = async function () {
  try{ localStorage.removeItem(LAST_ACTIVE_KEY); }catch(e){}
  await signOut(auth);
};
 
document.addEventListener('DOMContentLoaded', ()=>{
  const passEl=document.getElementById('loginPass');
  if(passEl) passEl.addEventListener('keydown', e=>{ if(e.key==='Enter') doLogin(); });
  const emailEl=document.getElementById('loginEmail');
  if(emailEl) emailEl.addEventListener('keydown', e=>{ if(e.key==='Enter') doLogin(); });
});
 
onAuthStateChanged(auth, (user) => {
  if (user && isIdleExpired()) {
    // Sesi lama masih tersimpan browser, tapi sudah idle terlalu lama → paksa logout
    signOut(auth);
    return;   // onAuthStateChanged akan terpanggil lagi dengan user=null
  }
  if (user) {
    markActive();
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('mainApp').classList.remove('hidden');
    startApp();
  } else {
    document.getElementById('loginScreen').classList.remove('hidden');
    document.getElementById('mainApp').classList.add('hidden');
  }
});
 
// ═══════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════
const DAYS=['Senin','Selasa','Rabu','Kamis','Jumat','Sabtu','Minggu'];
const MONTHS=['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
const TODAY_IDX=(new Date().getDay()+6)%7;
 
let currentId = KOMPLEK[0].id;
let activeListeners = []; // path-path onValue yang sedang aktif, untuk di-off saat ganti komplek
 
let TRACKS=[
  {file:'001.mp3',name:'Bel standar',dur:180},
  {file:'002.mp3',name:'Istirahat panjang',dur:180},
  {file:'003.mp3',name:'Adzan / sholat',dur:180},
  {file:'004.mp3',name:'Bel pulang',dur:180},
];
 
let schedule={}; DAYS.forEach((_,i)=>schedule[i]=[]);
let activeDay=TODAY_IDX;
let playTimer=null,curFile='',elapsed=0,curDur=0;
let isRinging=false, ampliOn=false, deviceOnline=false;
let kegiatanList=[];
let appStarted=false;
 
// ═══════════════════════════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════════════════════════
function toast(msg,dur=2200){
  const el=document.getElementById('toast');
  el.textContent=msg;el.classList.add('show');
  clearTimeout(el._t);
  el._t=setTimeout(()=>el.classList.remove('show'),dur);
}
 
// ═══════════════════════════════════════════════════════════════
// KOMPLEK SELECTOR
// ═══════════════════════════════════════════════════════════════
function buildKomplekSelector(){
  const el=document.getElementById('komplekSelect');
  el.innerHTML=KOMPLEK.map(k=>`
    <div class="komplek-chip" id="chip-${k.id}" onclick="selectKomplek('${k.id}')">
      <div class="dot"></div><span>${k.nama}</span>
    </div>`).join('');
  refreshChips();
}
function refreshChips(){
  KOMPLEK.forEach(k=>{
    const chip=document.getElementById('chip-'+k.id);
    if(!chip) return;
    chip.classList.toggle('active', k.id===currentId);
  });
}
window.selectKomplek = function(id){
  if(id===currentId) return;
  currentId=id;
  refreshChips();
  subscribeDevice(id);
  fillUploadIp();
  toast('Beralih ke '+ (KOMPLEK.find(k=>k.id===id)||{}).nama);
};
 
function fillUploadIp(){
  const ipInput=document.getElementById('uploadIp');
  if(!ipInput) return;
  const k=KOMPLEK.find(k=>k.id===currentId);
  ipInput.value = (k && k.localIp) || '';
}
 
// ═══════════════════════════════════════════════════════════════
// SUBSCRIBE DATA REALTIME UNTUK KOMPLEK AKTIF
// ═══════════════════════════════════════════════════════════════
function detachListeners(){
  activeListeners.forEach(p=>off(ref(db,p)));
  activeListeners=[];
}
 
function subscribeDevice(id){
  detachListeners();
 
  const pStatus = `devices/${id}/status`;
  const pJadwal = `devices/${id}/jadwal`;
  const pKeg    = `devices/${id}/kegiatan`;
  const pAudio  = `devices/${id}/audio`;
 
  onValue(ref(db,pStatus), snap=>{
    const s=snap.val();
    const dot=document.getElementById('connDot');
    const lbl=document.getElementById('connLbl');
    deviceOnline = !!s && (Date.now() - (s.lastSeen||0) < OFFLINE_THRESHOLD_MS);
    if(deviceOnline){
      dot.style.background='#1D9E75';dot.style.boxShadow='0 0 4px #1D9E75';
      lbl.textContent='Terhubung';
    } else {
      dot.style.background='#e24b4a';dot.style.boxShadow='none';
      lbl.textContent=s ? 'Offline (data terakhir tersimpan)' : 'Belum ada data';
    }
    const chip=document.getElementById('chip-'+id);
    if(chip){ chip.classList.toggle('online',deviceOnline); chip.classList.toggle('offline',!deviceOnline); }
 
    const wasRinging=isRinging;
    isRinging = s?.isRinging || false;
    ampliOn   = s?.ampliOn   || false;
    const aDot=document.getElementById('ampliDot'), aLbl=document.getElementById('ampliLbl');
    if(aDot&&aLbl){
      if(ampliOn){ aDot.style.background='#1D9E75';aDot.style.boxShadow='0 0 4px #1D9E75';aLbl.textContent='Amplifier ON'; }
      else{ aDot.style.background='#4b5563';aDot.style.boxShadow='none';aLbl.textContent='Amplifier OFF'; }
    }
    if(wasRinging!==isRinging) renderDash();
  });
  activeListeners.push(pStatus);
 
  onValue(ref(db,pJadwal), snap=>{
    const d=snap.val();
    if(!d){ DAYS.forEach((_,i)=>schedule[i]=[]); renderAllViews(); return; }
    DAYS.forEach((day,i)=>{
      const arr=d[day];
      schedule[i]=Array.isArray(arr)?arr.map(e=>({
        time:e.jam||'00:00', label:e.kegiatan||'-',
        track: typeof e.audio==='number'?e.audio:parseInt(e.audio)||1,
        active:true, done:isDone(i,e.jam)
      })):[];
    });
    renderAllViews();
  });
  activeListeners.push(pJadwal);
 
  onValue(ref(db,pKeg), snap=>{
    const d=snap.val();
    kegiatanList = Array.isArray(d) ? d.map(k=>({nama:k.nama||k||''})) : [];
    renderKegiatan();
    if(document.getElementById('tab-jadwal').classList.contains('active')) renderEdit();
  });
  activeListeners.push(pKeg);
 
  onValue(ref(db,pAudio), snap=>{
    const d=snap.val();
    if(Array.isArray(d) && d.length>0){
      TRACKS = d.map((t,i)=>({file:t.file||`${String(i+1).padStart(3,'0')}.mp3`, name:t.name||t.file, dur:t.dur||180}));
      renderTracks();
    }
  });
  activeListeners.push(pAudio);
}
 
function renderAllViews(){
  renderDash();
  if(document.getElementById('tab-jadwal').classList.contains('active')){ renderDayTabs(); renderEdit(); }
  if(document.getElementById('tab-json').classList.contains('active')) renderJSON();
}
 
// ═══════════════════════════════════════════════════════════════
// COMMAND CHANNEL (play/stop/volume/ringNow) → ESP32 tarik & eksekusi
// ═══════════════════════════════════════════════════════════════
async function sendCommand(action, params={}){
  const payload = { id: Date.now(), action, ...params };
  await set(ref(db, `devices/${currentId}/commands/current`), payload);
}
 
// ═══════════════════════════════════════════════════════════════
// TABS
// ═══════════════════════════════════════════════════════════════
window.gotoTab = function(t){
  document.querySelectorAll('.tab').forEach((b,i)=>b.classList.toggle('active',['dashboard','jadwal','kegiatan','audio','json'][i]===t));
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  document.getElementById('tab-'+t).classList.add('active');
  if(t==='jadwal'){renderDayTabs();renderEdit();}
  if(t==='dashboard'){renderDash();}
  if(t==='audio'){renderTracks();}
  if(t==='kegiatan'){renderKegiatan();}
  if(t==='json'){renderJSON();}
};
 
// ═══════════════════════════════════════════════════════════════
// CLOCK
// ═══════════════════════════════════════════════════════════════
function pad2(n){return String(n).padStart(2,'0');}
 
function updateClock(){
  const now=new Date();
  document.getElementById('clockTime').textContent=pad2(now.getHours())+':'+pad2(now.getMinutes())+':'+pad2(now.getSeconds());
  document.getElementById('clockDay').textContent=DAYS[(now.getDay()+6)%7];
  document.getElementById('clockDate').textContent=now.getDate()+' '+MONTHS[now.getMonth()]+' '+now.getFullYear();
  updateCountdown(now);
  if(now.getSeconds()===0){
    const today=schedule[TODAY_IDX]||[];
    today.forEach(e=>{ if(e.active) e.done=isDone(TODAY_IDX,e.time); });
    renderDash();
  }
}
 
function isDone(dayIdx,jam){
  if(dayIdx!==TODAY_IDX) return false;
  const now=new Date();
  if(!jam||jam.length<5) return false;
  const [bh,bm]=jam.split(':').map(Number);
  const nowMin=now.getHours()*60+now.getMinutes();
  return bh*60+bm < nowMin-1;
}
 
function updateCountdown(now){
  const el=document.getElementById('nCountdown');
  if(!el) return;
  const today=schedule[TODAY_IDX]||[];
  const next=today.find(e=>e.active&&!e.done);
  if(!next){el.textContent='Semua selesai hari ini';return;}
  const [bh,bm]=next.time.split(':').map(Number);
  const diff=bh*60+bm - (now.getHours()*60+now.getMinutes());
  if(diff<=0) el.textContent='Sekarang / lewat';
  else if(diff<60) el.textContent='dalam '+diff+' menit';
  else el.textContent='dalam '+Math.floor(diff/60)+'j '+diff%60+'m';
}
 
function getBadge(e,isCurrent){
  if(isCurrent) return '<span class="badge b-ring">Bunyi</span>';
  if(e.done)    return '<span class="badge b-ok">Sudah</span>';
  if(e.active)  return '<span class="badge b-wait">Menunggu</span>';
  return '<span class="badge b-off">Nonaktif</span>';
}
 
// ═══════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════
function trackName(id){
  const t=TRACKS.find(t=>t.file===String(id).padStart(3,'0')+'.mp3');
  return t?t.name:TRACKS[id-1]?TRACKS[id-1].name:'Track '+id;
}
 
function renderDash(){
  const today=schedule[TODAY_IDX]||[];
  const now=new Date();
  const nowMin=now.getHours()*60+now.getMinutes();
  const active=today.filter(e=>e.active);
  const done=today.filter(e=>e.active&&e.done);
  const nonaktif=today.filter(e=>!e.active);
  document.getElementById('mDone').textContent=done.length;
  document.getElementById('mBunyi').textContent=isRinging?'1':'0';
  document.getElementById('mLeft').textContent=active.length-done.length-(isRinging?1:0);
  document.getElementById('mNonaktif').textContent=nonaktif.length;
  document.getElementById('mBunyiCard').className='metric'+(isRinging?' metric-ring':'');
  const next=today.find(e=>e.active&&!e.done);
  if(next){
    document.getElementById('nTime').textContent=next.time;
    document.getElementById('nLabel').textContent=next.label;
    document.getElementById('nTrack').textContent=trackName(next.track);
  } else {
    document.getElementById('nTime').textContent='--:--';
    document.getElementById('nLabel').textContent='Semua selesai';
    document.getElementById('nTrack').textContent='';
  }
  const tbody=document.getElementById('todayTbody');
  tbody.innerHTML='';
  today.forEach(e=>{
    const tr=document.createElement('tr');
    const [bh,bm]=e.time.split(':').map(Number);
    const isCurrent=isRinging&&Math.abs(bh*60+bm-nowMin)<=1;
    tr.innerHTML=`<td style="font-family:var(--mono);font-size:12px">${e.time}</td><td>${e.label}</td><td style="color:var(--text2);font-size:12px">${trackName(e.track)}</td><td>${getBadge(e,isCurrent)}</td>`;
    tbody.appendChild(tr);
  });
}
 
window.ringNow = async function(){
  const btn=event.target;
  const next=(schedule[TODAY_IDX]||[]).find(e=>e.active&&!e.done);
  const file=next?String(next.track).padStart(3,'0')+'.mp3':'001.mp3';
  btn.textContent='Berbunyi...';btn.disabled=true;
  await sendCommand('ringNow',{file});
  toast('Perintah bunyi dikirim ke '+currentId);
  setTimeout(()=>{btn.textContent='Bunyikan sekarang';btn.disabled=false;},3000);
};
 
// ═══════════════════════════════════════════════════════════════
// JADWAL EDITOR
// ═══════════════════════════════════════════════════════════════
function renderDayTabs(){
  const dt=document.getElementById('dayTabs');
  const ct=document.getElementById('copyTarget');
  dt.innerHTML='';ct.innerHTML='<option value="">Pilih hari...</option>';
  DAYS.forEach((d,i)=>{
    const btn=document.createElement('button');
    btn.className='day-tab'+(i===activeDay?' active':'')+(i===TODAY_IDX?' today':'');
    btn.textContent=d;
    const cnt=(schedule[i]||[]).filter(e=>e.active).length;
    if(cnt>0){const dot=document.createElement('div');dot.className='day-dot';btn.appendChild(dot);}
    btn.onclick=()=>{activeDay=i;renderDayTabs();renderEdit();};
    dt.appendChild(btn);
    if(i!==activeDay){const opt=document.createElement('option');opt.value=i;opt.textContent=d;ct.appendChild(opt);}
  });
}
 
function renderEdit(){
  const tbody=document.getElementById('editTbody');
  const entries=schedule[activeDay]||[];
  tbody.innerHTML='';
  if(!entries.length){
    tbody.innerHTML=`<tr><td colspan="5" style="text-align:center;color:var(--text2);padding:1.5rem;font-size:13px">Belum ada jadwal. Klik "+ Tambah bel"</td></tr>`;
    return;
  }
  entries.forEach((e,i)=>{
    const tr=document.createElement('tr');
    if(!e.active) tr.style.opacity='0.4';
 
    const tdJam=document.createElement('td');
    const inpJam=document.createElement('input');
    inpJam.type='time'; inpJam.value=e.time;
    inpJam.disabled=!e.active;
    inpJam.onchange=()=>{ schedule[activeDay][i].time=inpJam.value; sortEntries(); };
    tdJam.appendChild(inpJam);
 
    const tdKeg=document.createElement('td');
    const selKeg=document.createElement('select');
    selKeg.disabled=!e.active;
    if(kegiatanList.length){
      kegiatanList.forEach(k=>{
        const opt=document.createElement('option');
        opt.value=k.nama; opt.textContent=k.nama;
        if(k.nama===e.label) opt.selected=true;
        selKeg.appendChild(opt);
      });
    } else {
      const opt=document.createElement('option');
      opt.value=e.label; opt.textContent=e.label||'(kosong)';
      opt.selected=true; selKeg.appendChild(opt);
    }
    selKeg.onchange=()=>{ schedule[activeDay][i].label=selKeg.value; };
    tdKeg.appendChild(selKeg);
 
    const tdTrack=document.createElement('td');
    const selTrack=document.createElement('select');
    selTrack.disabled=!e.active;
    TRACKS.forEach((t,ti)=>{
      const opt=document.createElement('option');
      opt.value=ti+1; opt.textContent=t.name;
      if(ti+1===e.track) opt.selected=true;
      selTrack.appendChild(opt);
    });
    selTrack.onchange=()=>{ schedule[activeDay][i].track=+selTrack.value; };
    tdTrack.appendChild(selTrack);
 
    const tdChk=document.createElement('td');
    tdChk.style.textAlign='center';
    const chk=document.createElement('input');
    chk.type='checkbox'; chk.checked=e.active;
    chk.onchange=()=>{
      schedule[activeDay][i].active=chk.checked;
      tr.style.opacity=chk.checked?'1':'0.4';
      inpJam.disabled=!chk.checked;
      selKeg.disabled=!chk.checked;
      selTrack.disabled=!chk.checked;
      renderDayTabs();
    };
    tdChk.appendChild(chk);
 
    const tdDel=document.createElement('td');
    const btnDel=document.createElement('button');
    btnDel.className='btn btn-sm btn-d';
    btnDel.innerHTML='&#x2715;';
    btnDel.onclick=()=>delEntry(i);
    tdDel.appendChild(btnDel);
 
    tr.append(tdJam,tdKeg,tdTrack,tdChk,tdDel);
    tbody.appendChild(tr);
  });
}
 
function sortEntries(){schedule[activeDay].sort((a,b)=>a.time.localeCompare(b.time));renderEdit();}
window.addEntry = function(){
  if(!schedule[activeDay]) schedule[activeDay]=[];
  const defLabel=kegiatanList.length?kegiatanList[0].nama:'';
  schedule[activeDay].push({time:'08:00',label:defLabel,track:1,active:true,done:false});
  renderEdit();renderDayTabs();
};
window.delEntry = function(i){schedule[activeDay].splice(i,1);renderEdit();renderDayTabs();};
window.copyToDay = function(){
  const t=document.getElementById('copyTarget').value;if(!t) return;
  const src=JSON.parse(JSON.stringify(schedule[activeDay]));
  src.forEach(e=>e.done=false);schedule[+t]=src;
  renderDayTabs();toast('Jadwal '+DAYS[activeDay]+' disalin ke '+DAYS[+t]);
};
window.clearDay = function(){
  if(!confirm('Hapus semua jadwal '+DAYS[activeDay]+'?')) return;
  schedule[activeDay]=[];renderEdit();renderDayTabs();
};
 
function scheduleToJadwalObj(){
  const out={};
  DAYS.forEach((d,i)=>{ out[d]=(schedule[i]||[]).map(e=>({jam:e.time,kegiatan:e.label,audio:e.track})); });
  return out;
}
 
window.saveAll = async function(){
  const btn=event.target;btn.textContent='Menyimpan...';btn.disabled=true;
  try{
    await set(ref(db, `devices/${currentId}/jadwal`), scheduleToJadwalObj());
    toast('Jadwal tersimpan — ESP32 akan menarik dalam beberapa detik',2500);
    btn.textContent='Tersimpan!';
  }catch(e){
    toast('Gagal menyimpan ke Firebase — cek koneksi internet');
    btn.textContent='Simpan semua';
  }
  setTimeout(()=>{btn.textContent='Simpan semua';btn.disabled=false;},2000);
};
 
// ═══════════════════════════════════════════════════════════════
// AUDIO
// ═══════════════════════════════════════════════════════════════
function fmtDur(s){return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');}
 
function renderTracks(){
  const d=document.getElementById('dfPanel');
  d.innerHTML=TRACKS.map((t,i)=>`
    <div class="df-track">
      <div class="df-num">${String(i+1).padStart(3,'0')}</div>
      <div class="df-name">${t.name}</div>
      <span style="font-size:10px;color:#6b7280;margin-right:6px">${fmtDur(t.dur)}</span>
      <button class="df-play" id="dfp${i}" onclick="playTrackUi(${i},'${t.file}',${t.dur})">&#9654;</button>
    </div>`).join('');
}
 
window.playTrackUi = async function(idx,file,dur){
  if(curFile===file){window.stopAudio();return;}
  stopT();curFile=file;curDur=dur;elapsed=0;
  document.getElementById('dfp'+idx).innerHTML='&#9632;';
  document.getElementById('dfp'+idx).classList.add('playing');
  document.getElementById('tTot').textContent=fmtDur(dur);
  playTimer=setInterval(()=>{
    elapsed++;
    document.getElementById('progBar').style.width=Math.round(elapsed/dur*100)+'%';
    document.getElementById('tNow').textContent=fmtDur(elapsed);
    if(elapsed>=dur) stopT();
  },1000);
  await sendCommand('play',{file});
  toast('Perintah play dikirim: '+file);
};
 
function stopT(){
  clearInterval(playTimer);playTimer=null;curFile='';elapsed=0;
  document.querySelectorAll('.df-play').forEach(b=>{b.innerHTML='&#9654;';b.classList.remove('playing');});
  document.getElementById('progBar').style.width='0%';
  document.getElementById('tNow').textContent='0:00';
}
 
window.stopAudio = async function(){
  stopT();
  await sendCommand('stop');
  toast('Perintah stop dikirim');
};
 
window.applyVolume = async function(){
  const btn=event.target;btn.textContent='Menerapkan...';btn.disabled=true;
  const v=+document.getElementById('volR').value;
  await sendCommand('volume',{val:v});
  toast('Perintah volume dikirim: '+v);
  btn.textContent='Diterapkan!';
  setTimeout(()=>{btn.textContent='Terapkan volume';btn.disabled=false;},1800);
};
 
// ── Upload MP3 baru — LANGSUNG ke ESP32 lewat WiFi lokal ─────────
// (Anda harus terhubung ke WiFi sekolah yang sama dengan ESP32 saat upload)
function getAudioDuration(file){
  return new Promise((resolve)=>{
    const url=URL.createObjectURL(file);
    const a=new Audio();
    a.preload='metadata';
    a.onloadedmetadata=()=>{ URL.revokeObjectURL(url); resolve(Math.round(a.duration)||180); };
    a.onerror=()=>{ URL.revokeObjectURL(url); resolve(180); };  // fallback 180s kalau gagal baca metadata
    a.src=url;
  });
}
 
window.uploadAudioFile = async function(){
  const fileInput=document.getElementById('uploadFile');
  const nameInput=document.getElementById('uploadName');
  const ipInput=document.getElementById('uploadIp');
  const file=fileInput.files[0];
  if(!file){ toast('Pilih file MP3 dulu'); return; }
  if(!file.name.toLowerCase().endsWith('.mp3')){ toast('Hanya file .mp3 yang didukung'); return; }
  if(file.size > 8*1024*1024){ toast('Ukuran file terlalu besar (maks 8MB)'); return; }
  const ip=ipInput.value.trim();
  if(!ip){ toast('Isi dulu IP lokal ESP32 (lihat Serial Monitor)'); return; }
 
  const displayName = nameInput.value.trim() || file.name.replace(/\.mp3$/i,'');
  const nextNum = TRACKS.length + 1;
  const fileName = String(nextNum).padStart(3,'0')+'.mp3';
 
  const btn=event.target;
  const progWrap=document.getElementById('uploadProgWrap');
  const progLbl=document.getElementById('uploadProgLbl');
  progWrap.classList.add('show');
 
  btn.disabled=true; btn.textContent='Membaca durasi...';
  const dur = await getAudioDuration(file);
 
  btn.textContent='Mengunggah ke ESP32...';
  progLbl.textContent='Mengirim '+fileName+' ke '+ip+' ...';
 
  try{
    const fd=new FormData();
    fd.append('file', file, fileName);   // nama field 'file' HARUS cocok dgn firmware; nama file jadi target di SD
 
    const res=await fetch(`http://${ip}/upload-audio`, { method:'POST', body:fd });
    const text=await res.text();
 
    if(!res.ok){ throw new Error(text||('HTTP '+res.status)); }
 
    // Upload ke ESP32 berhasil → catat metadata di Firebase supaya dashboard & LCD ikut update
    const newTracks=[...TRACKS, {file:fileName, name:displayName, dur}];
    await set(ref(db, `devices/${currentId}/audio`), newTracks);
 
    toast('Upload berhasil: '+fileName,3000);
    progLbl.textContent='Selesai — '+text;
    fileInput.value=''; nameInput.value='';
  }catch(e){
    toast('Upload gagal: '+e.message+' — pastikan Anda di WiFi yang sama dengan ESP32');
    progLbl.textContent='Gagal: '+e.message;
  }
  btn.disabled=false; btn.textContent='Upload ke ESP32';
  setTimeout(()=>{progWrap.classList.remove('show');},4000);
};
 
// ═══════════════════════════════════════════════════════════════
// KEGIATAN
// ═══════════════════════════════════════════════════════════════
function renderKegiatan(){
  const tbody=document.getElementById('kegiatanTbody');
  if(!tbody) return;
  tbody.innerHTML='';
  if(!kegiatanList.length){
    tbody.innerHTML=`<tr><td colspan="3" style="text-align:center;color:var(--text2);padding:1.5rem;font-size:13px">Belum ada kegiatan. Klik "+ Tambah"</td></tr>`;
    return;
  }
  kegiatanList.forEach((k,i)=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`
      <td style="text-align:center;color:var(--text2);font-size:12px">${i+1}</td>
      <td><input type="text" value="${k.nama}" placeholder="Nama kegiatan" oninput="updateKegiatanNama(${i},this.value)"></td>
      <td style="text-align:center"><button class="btn btn-sm btn-d" onclick="delKegiatan(${i})">&#x2715;</button></td>`;
    tbody.appendChild(tr);
  });
}
 
window.addKegiatan = function(){
  kegiatanList.push({nama:''});
  renderKegiatan();
  const inputs=document.querySelectorAll('#kegiatanTbody input[type=text]');
  if(inputs.length) inputs[inputs.length-1].focus();
};
window.updateKegiatanNama = function(i, val){
  if(kegiatanList[i]) kegiatanList[i].nama = val;
};
window.delKegiatan = function(i){kegiatanList.splice(i,1);renderKegiatan();};
 
window.saveKegiatan = async function(){
  const btn=event.target;
  kegiatanList=kegiatanList.filter(k=>k.nama.trim()!=='');
  renderKegiatan();
  btn.textContent='Menyimpan...';btn.disabled=true;
  try{
    await set(ref(db, `devices/${currentId}/kegiatan`), kegiatanList.map(k=>({nama:k.nama.trim()})));
    toast('Kegiatan tersimpan',2500);
    btn.textContent='Tersimpan!';
  }catch(e){
    toast('Gagal menyimpan — cek koneksi internet');
    btn.textContent='Gagal';
  }
  setTimeout(()=>{btn.textContent='Simpan';btn.disabled=false;},2000);
};
 
// ═══════════════════════════════════════════════════════════════
// JSON — backup / restore langsung dari Firebase
// ═══════════════════════════════════════════════════════════════
function renderJSON(){
  document.getElementById('jsonBox').textContent=JSON.stringify(scheduleToJadwalObj(),null,2);
}
window.cpJSON = function(){
  navigator.clipboard.writeText(document.getElementById('jsonBox').textContent);
  const b=event.target;b.textContent='Tersalin!';setTimeout(()=>b.textContent='Salin JSON',1200);
};
window.dlJSON = function(){
  const blob=new Blob([document.getElementById('jsonBox').textContent],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=currentId+'_jadwal.json';a.click();
};
window.pushJSON = async function(){
  const b=event.target;b.textContent='Mengirim...';b.disabled=true;
  try{
    const obj=JSON.parse(document.getElementById('jsonBox').textContent);
    await set(ref(db, `devices/${currentId}/jadwal`), obj);
    toast('Jadwal berhasil dikirim ke Firebase!',2500);
    b.textContent='Berhasil!';
  }catch(e){
    toast('Gagal mengirim — JSON tidak valid atau koneksi bermasalah');
    b.textContent='Gagal';
  }
  setTimeout(()=>{b.textContent='Kirim ke Firebase';b.disabled=false;},2000);
};
 
window.downloadBackup = async function(){
  try{
    const [jSnap,kSnap]=await Promise.all([
      get(ref(db,`devices/${currentId}/jadwal`)),
      get(ref(db,`devices/${currentId}/kegiatan`)),
    ]);
    const out={jadwal:jSnap.val()||{}, kegiatan:kSnap.val()||[]};
    const blob=new Blob([JSON.stringify(out,null,2)],{type:'application/json'});
    const now=new Date();
    const ts=now.getFullYear()+pad2(now.getMonth()+1)+pad2(now.getDate())+'_'+pad2(now.getHours())+pad2(now.getMinutes());
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`backup_${currentId}_${ts}.json`;a.click();
    toast('Backup diunduh',3000);
  }catch(e){ toast('Gagal mengunduh backup — cek koneksi'); }
};
 
window.restoreBackup = async function(input){
  const file=input.files[0];if(!file) return;
  const statusEl=document.getElementById('restoreStatus');
  statusEl.textContent='Membaca file...';statusEl.style.color='var(--amber-text)';
  try{
    const text=await file.text();
    const parsed=JSON.parse(text);
    if(!parsed.jadwal&&!parsed.kegiatan){statusEl.textContent='Format tidak valid!';statusEl.style.color='var(--red-text)';input.value='';return;}
    statusEl.textContent='Mengirim ke Firebase...';
    if(parsed.jadwal)   await set(ref(db, `devices/${currentId}/jadwal`), parsed.jadwal);
    if(parsed.kegiatan)  await set(ref(db, `devices/${currentId}/kegiatan`), parsed.kegiatan);
    statusEl.textContent='Berhasil dipulihkan!';statusEl.style.color='var(--green-text)';
    toast('Data berhasil direstore!',3000);
    setTimeout(()=>{statusEl.textContent='';},5000);
  }catch(e){statusEl.textContent='File JSON tidak valid';statusEl.style.color='var(--red-text)';}
  input.value='';
};
 
// ═══════════════════════════════════════════════════════════════
// INIT (dipanggil setelah login berhasil)
// ═══════════════════════════════════════════════════════════════
function startApp(){
  if(appStarted) return;   // hindari double-init jika onAuthStateChanged terpanggil lagi
  appStarted=true;
  buildKomplekSelector();
  subscribeDevice(currentId);
  fillUploadIp();
  renderTracks();
  updateClock();
  setInterval(updateClock,1000);
  setInterval(refreshChips,5000);
}
