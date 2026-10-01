import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { APP_CONFIG } from './config.js?v=2.17';

const $=id=>document.getElementById(id);
const APP_VERSION=APP_CONFIG.version;
const DB_NAME='UTOP_CCTV_V2';
const STORE_NAME='projects';
const UI_KEY='utop-cctv-v2-ui';
const API_CACHE_KEY='utop-cctv-v217-api-url';
let cloudProjects=[];
let cloudConnected=false;
let activeApiUrl='';
let jsonpSeq=0;
const LENS={'2.8':{fov:102,range:14},'3.6':{fov:84,range:17},'4':{fov:76,range:18},'6':{fov:53,range:25},'8':{fov:40,range:32}};
const COLORS={existing:0xdc2626,new:0xeab308,fault:0xf97316};
const FLOORS=['RF','R1F','1MF','1F','2F','3F','B1','B2','B3','B4','B5','B6','自訂'];
let db,currentProject=null,currentScene=null,selected={kind:null,id:null},mode='select',drag=null,floorPlane=null;
let uiState=loadUIState();
let draftWall={points:[],mousePoint:null};
let newCameraStars=[];

let cloudLoadCancelRequested=false;
let cloudLoadStartedAt=0;
let cloudLoadTimer=null;

function formatBytes(bytes){
  const n=Number(bytes||0);
  if(n<1024)return `${n} B`;
  if(n<1024*1024)return `${(n/1024).toFixed(1)} KB`;
  return `${(n/1024/1024).toFixed(2)} MB`;
}

function openCloudLoadModal(projectName){
  cloudLoadCancelRequested=false;
  if($('cancelCloudLoadBtn')){$('cancelCloudLoadBtn').disabled=false;$('cancelCloudLoadBtn').textContent='取消讀取';}
  cloudLoadStartedAt=Date.now();
  $('cloudLoadProjectName').textContent=projectName||'雲端專案';
  $('cloudLoadModal').classList.remove('hidden');
  $('cloudLoadModal').querySelector('.cloud-load-card')?.classList.remove('is-error','is-done');
  setCloudLoadProgress(2,'準備連線 Google Drive','正在建立 Apps Script / Google Drive 讀取工作階段。',1,0,0);
  clearInterval(cloudLoadTimer);
  cloudLoadTimer=setInterval(()=>{
    const sec=Math.max(0,Math.floor((Date.now()-cloudLoadStartedAt)/1000));
    if($('cloudLoadElapsed'))$('cloudLoadElapsed').textContent=`${sec} 秒`;
  },500);
}

function closeCloudLoadModal(delay=0){
  const close=()=>{
    clearInterval(cloudLoadTimer);
    cloudLoadTimer=null;
    $('cloudLoadModal')?.classList.add('hidden');
  };
  if(delay)setTimeout(close,delay);else close();
}

function setCloudLoadProgress(percent,stage,subtext,step=1,loadedBytes=0,totalBytes=0){
  const pct=Math.max(0,Math.min(100,Math.round(Number(percent||0))));
  if($('cloudProgressBar'))$('cloudProgressBar').style.width=`${pct}%`;
  if($('cloudLoadPercent'))$('cloudLoadPercent').textContent=`${pct}%`;
  if($('cloudLoadStage'))$('cloudLoadStage').textContent=stage||'處理中…';
  if($('cloudLoadSubtext'))$('cloudLoadSubtext').textContent=subtext||'';
  if($('cloudLoadStep'))$('cloudLoadStep').textContent=`${step} / 6`;
  if($('cloudLoadBytes')){
    $('cloudLoadBytes').textContent=totalBytes
      ? `${formatBytes(loadedBytes)} / ${formatBytes(totalBytes)}`
      : formatBytes(loadedBytes);
  }
}

function throwIfCloudLoadCancelled(){
  if(cloudLoadCancelRequested){
    throw new Error('使用者已取消雲端專案讀取');
  }
}


function uid(p='id'){return `${p}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`}
function clone(v){return JSON.parse(JSON.stringify(v))}
function now(){return new Date().toISOString()}
function esc(s=''){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function toast(msg){$('toast').textContent=msg;$('toast').classList.remove('hidden');clearTimeout(toast.t);toast.t=setTimeout(()=>$('toast').classList.add('hidden'),2200)}
function loadUIState(){try{return JSON.parse(localStorage.getItem(UI_KEY)||'{}')}catch{return{}}}
function saveUIState(){localStorage.setItem(UI_KEY,JSON.stringify(uiState))}

function openDb(){return new Promise((resolve,reject)=>{const r=indexedDB.open(DB_NAME,1);r.onupgradeneeded=()=>{const d=r.result;if(!d.objectStoreNames.contains(STORE_NAME))d.createObjectStore(STORE_NAME,{keyPath:'id'})};r.onsuccess=()=>{db=r.result;resolve()};r.onerror=()=>reject(r.error)})}
function dbPut(p){return new Promise((resolve,reject)=>{const t=db.transaction(STORE_NAME,'readwrite');t.objectStore(STORE_NAME).put(p);t.oncomplete=()=>resolve(p);t.onerror=()=>reject(t.error)})}
function dbGet(id){return new Promise((resolve,reject)=>{const r=db.transaction(STORE_NAME).objectStore(STORE_NAME).get(id);r.onsuccess=()=>resolve(r.result||null);r.onerror=()=>reject(r.error)})}
function dbDelete(id){return new Promise((resolve,reject)=>{const r=db.transaction(STORE_NAME,'readwrite').objectStore(STORE_NAME).delete(id);r.onsuccess=resolve;r.onerror=()=>reject(r.error)})}
function dbAll(){return new Promise((resolve,reject)=>{const r=db.transaction(STORE_NAME).objectStore(STORE_NAME).getAll();r.onsuccess=()=>resolve((r.result||[]).sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt))));r.onerror=()=>reject(r.error)})}

function setCloudStatus(ok,text,working=false){
  cloudConnected=!!ok;
  const cls=working?'syncing':ok?'online':'offline';
  const home=$('homeCloudStatus'),editor=$('editorCloudStatus');
  if(home){home.className=`cloud-badge ${cls}`;home.textContent=text|| (ok?'雲端已連線':'雲端未連線');}
  if(editor){editor.className=`cloud-badge ${cls}`;editor.textContent=text|| (ok?'雲端已連線':'雲端未連線');}
}
function parseCsvCell(text){let s=String(text||'').trim();if(s.startsWith('"')&&s.endsWith('"'))s=s.slice(1,-1).replace(/""/g,'"');return s.trim()}
async function getApiUrl(force=false){
  if(!APP_CONFIG.cloudApi?.enabled)throw new Error('雲端 API 尚未啟用');
  if(!force&&activeApiUrl)return activeApiUrl;

  // V2.2：使用 config.js 內明確指定的正式 /exec 為第一優先。
  // 不再讓 Google Sheets B1 的讀取阻塞網站首次雲端連線。
  const configured=String(APP_CONFIG.cloudApi.apiUrl||'').trim().replace(/\?.*$/,'');
  if(/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/i.test(configured)){
    activeApiUrl=configured;
    localStorage.setItem(API_CACHE_KEY,configured);
    return configured;
  }

  const cached=String(localStorage.getItem(API_CACHE_KEY)||'').trim().replace(/\?.*$/,'');
  if(/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/i.test(cached)){
    activeApiUrl=cached;
    return cached;
  }

  // 最後才嘗試工作表1!B2。
  try{
    const sheet=encodeURIComponent(APP_CONFIG.cloudApi.configSheet||'工作表1');
    const cell=encodeURIComponent(APP_CONFIG.cloudApi.apiCell||'B1');
    const url=`https://docs.google.com/spreadsheets/d/${APP_CONFIG.googleSheetId}/gviz/tq?tqx=out:csv&sheet=${sheet}&range=${cell}&_=${Date.now()}`;
    const res=await fetch(url,{cache:'no-store'});
    if(!res.ok)throw new Error(`B2 HTTP ${res.status}`);
    const b1=parseCsvCell(await res.text()).replace(/\?.*$/,'');
    if(/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/i.test(b1)){
      activeApiUrl=b1;
      localStorage.setItem(API_CACHE_KEY,b1);
      return b1;
    }
  }catch(err){
    console.warn('工作表1!B2 備援讀取失敗：',err);
  }

  throw new Error('沒有可用的 Apps Script /exec');
}

function jsonpGet(action,params={},timeoutMs=30000){
  return new Promise(async(resolve,reject)=>{
    try{
      const base=await getApiUrl();
      const cb=`__cctvV22_${Date.now()}_${++jsonpSeq}`;
      const u=new URL(base);
      u.searchParams.delete('action');
      u.searchParams.delete('callback');
      u.searchParams.set('action',action);
      u.searchParams.set('callback',cb);
      u.searchParams.set('_ts',Date.now());
      Object.entries(params).forEach(([k,v])=>{
        if(v!==undefined&&v!==null)u.searchParams.set(k,String(v));
      });

      const script=document.createElement('script');
      script.async=true;
      let done=false,timer=null;

      const cleanup=(late=false)=>{
        if(done)return;
        done=true;
        if(timer)clearTimeout(timer);
        script.remove();
        if(late){
          window[cb]=()=>{};
          setTimeout(()=>{try{delete window[cb]}catch{}},120000);
        }else{
          try{delete window[cb]}catch{}
        }
      };

      window[cb]=data=>{
        cleanup(false);
        resolve(data);
      };

      script.onerror=()=>{
        cleanup(false);
        reject(new Error(`JSONP API 載入失敗：${action}`));
      };

      timer=setTimeout(()=>{
        cleanup(true);
        reject(new Error(`JSONP API ${action} 逾時（${Math.round(timeoutMs/1000)} 秒）`));
      },timeoutMs);

      script.src=u.toString();
      document.head.appendChild(script);
    }catch(err){
      reject(err);
    }
  });
}

async function formPost(body){
  const base=await getApiUrl();
  const frameName=`cctvPost_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const iframe=document.createElement('iframe');iframe.name=frameName;iframe.style.display='none';
  const form=document.createElement('form');form.method='POST';form.action=base;form.target=frameName;form.style.display='none';form.acceptCharset='UTF-8';
  const input=document.createElement('input');input.type='hidden';input.name='payload';input.value=JSON.stringify(body);form.appendChild(input);
  document.body.append(iframe,form);form.submit();setTimeout(()=>{form.remove();iframe.remove()},6000);
}
function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
async function listCloudProjects(){const r=await jsonpGet('listProjects',{},45000);if(!r?.ok)throw new Error(r?.message||'讀取雲端專案失敗');return Array.isArray(r.projects)?r.projects:[]}
async function pollCloud(predicate,{timeout=60000,interval=1500}={}){const start=Date.now();let last=[];while(Date.now()-start<timeout){last=await listCloudProjects();if(predicate(last))return last;await sleep(interval)}throw new Error('雲端狀態確認逾時')}
async function getCloudProjectChunked(projectId){
  const parts=[];
  let offset=0;
  const limit=400000; // V2.4：由 100KB 提升為 400KB，減少往返次數。
  let totalLength=0;

  setCloudLoadProgress(
    8,
    '正在取得 Google Drive 專案',
    '正在向 Apps Script 要求專案內容，第一個資料區塊通常會稍久一些。',
    2,
    0,
    0
  );

  for(let i=0;i<80;i++){
    throwIfCloudLoadCancelled();

    const chunkNo=i+1;
    if(i>0){
      setCloudLoadProgress(
        Math.max(10, Math.round((offset/Math.max(totalLength,1))*78)),
        `正在下載專案資料｜第 ${chunkNo} 段`,
        '大型平面圖會包含圖片資料，因此雲端專案可能需要分段下載。',
        3,
        offset,
        totalLength
      );
    }

    const r=await jsonpGet(
      'getProjectChunk',
      {projectId,offset,limit},
      45000
    );

    throwIfCloudLoadCancelled();

    if(!r?.ok)throw new Error(r?.message||'分段讀取失敗');

    const chunk=String(r.chunk||'');
    parts.push(chunk);

    totalLength=Number(r.totalLength||totalLength||0);
    offset=Number(r.nextOffset||offset+chunk.length);

    const readPct=Number(r.progress||0);
    const visualPct=10+Math.round(readPct*72);

    setCloudLoadProgress(
      visualPct,
      `正在下載專案資料｜第 ${chunkNo} 段`,
      r.done
        ? '雲端資料下載完成，準備解析專案內容。'
        : `已完成 ${Math.round(readPct*100)}%，請稍候。`,
      3,
      offset,
      totalLength
    );

    if(r.done){
      throwIfCloudLoadCancelled();

      setCloudLoadProgress(
        85,
        '正在組合專案資料',
        `已完成 ${chunkNo} 個資料區塊，正在合併並檢查 JSON 格式。`,
        4,
        offset,
        totalLength
      );

      await new Promise(resolve=>setTimeout(resolve,30));

      const raw=parts.join('');
      let wrapper;
      try{
        wrapper=JSON.parse(raw);
      }catch(err){
        throw new Error(`專案資料下載完成，但 JSON 解析失敗：${err.message}`);
      }

      setCloudLoadProgress(
        90,
        '專案資料解析完成',
        '正在準備寫入本機快取，接著載入 3D 場景。',
        4,
        offset,
        totalLength
      );

      return {
        project:wrapper.project||wrapper.data||wrapper,
        loadedBytes:offset,
        totalBytes:totalLength,
        chunkCount:chunkNo
      };
    }
  }

  throw new Error('雲端專案分段數量超過安全上限');
}

function setCloudDiagnostics(message,details=''){
  const box=$('cloudDiagnostics');
  const text=$('cloudDiagnosticsText');
  if(!box||!text)return;
  const full=[message,details].filter(Boolean).join('\n');
  text.textContent=full;
  box.classList.toggle('hidden',!full);
}
async function testCloudConnection(){
  activeApiUrl='';
  const apiUrl=await getApiUrl(true);
  setCloudDiagnostics('正在測試雲端…',`API：${apiUrl}`);
  const ping=await jsonpGet('ping',{},30000);
  if(!ping?.ok)throw new Error(ping?.message||'ping 失敗');
  return {apiUrl,ping};
}
async function renderCloudProjectCards(){
  const el=$('cloudProjectCards');
  if(!el)return;

  setCloudStatus(false,'連線中…',true);
  el.innerHTML='<div class="empty-card">正在測試 Apps Script 與讀取雲端專案…</div>';

  try{
    const {apiUrl,ping}=await testCloudConnection();
    const apiVersion=String(ping.apiVersion||'未知');
    if(apiVersion!=='2.17'){
      console.warn(`目前 Apps Script API 版本：${apiVersion}，前端：2.17`);
    }

    cloudProjects=await listCloudProjects();
    setCloudStatus(true,`雲端已連線｜${cloudProjects.length} 筆`);
    setCloudDiagnostics('', '');

    if(!cloudProjects.length){
      el.innerHTML='<div class="empty-card">雲端已連線。Google Drive 尚無專案；建立專案後按「儲存」即可同步。</div>';
      return;
    }

    el.innerHTML=cloudProjects.map(p=>`
      <article class="project-card cloud-card">
        <div>
          <h3>${esc(p.projectName||'未命名專案')}</h3>
          <div class="meta">${esc(p.siteType||'')}<br>${esc(p.address||'')}</div>
          <span class="source-pill">Google Drive</span>
        </div>
        <div class="card-footer">
          <span class="meta">${p.updatedAt?new Date(p.updatedAt).toLocaleString():''}</span>
          <button data-open-cloud="${esc(p.projectId)}">開啟專案</button>
        </div>
      </article>
    `).join('');

    el.querySelectorAll('[data-open-cloud]').forEach(b=>{
      b.onclick=()=>openCloudProject(b.dataset.openCloud);
    });
  }catch(err){
    const api=activeApiUrl||APP_CONFIG.cloudApi?.apiUrl||'未取得';
    setCloudStatus(false,'雲端連線失敗');
    el.innerHTML='<div class="empty-card">雲端尚未連線。請查看下方診斷資訊後按「重新測試」。</div>';
    setCloudDiagnostics(
      `錯誤：${err.message}`,
      `前端：${APP_VERSION}\nAPI：${api}\nGitHub：${APP_CONFIG.githubPages||location.href}`
    );
    console.warn('Cloud connection error:',err);
  }
}

async function openCloudProject(projectId){
  const meta=cloudProjects.find(p=>String(p.projectId)===String(projectId));
  const projectName=meta?.projectName||'雲端專案';

  openCloudLoadModal(projectName);
  setCloudStatus(false,'讀取中',true);

  try{
    setCloudLoadProgress(
      4,
      '正在確認雲端連線',
      '確認 Apps Script API 與 Google Drive 專案索引。',
      1,
      0,
      0
    );

    const ping=await jsonpGet('ping',{},30000);
    throwIfCloudLoadCancelled();
    if(!ping?.ok)throw new Error(ping?.message||'Apps Script ping 失敗');

    setCloudLoadProgress(
      7,
      '雲端連線正常',
      `Apps Script API ${ping.apiVersion||'未知'} 已回應，開始讀取「${projectName}」。`,
      1,
      0,
      0
    );

    const result=await getCloudProjectChunked(projectId);
    const p=result.project;

    if(!p?.name)throw new Error('雲端專案格式不正確');

    throwIfCloudLoadCancelled();

    setCloudLoadProgress(
      93,
      '正在建立本機快取',
      '將雲端專案保存到瀏覽器，之後再次開啟會更方便。',
      5,
      result.loadedBytes,
      result.totalBytes
    );

    await dbPut(p);

    throwIfCloudLoadCancelled();

    setCloudLoadProgress(
      97,
      '正在建立 3D 場景',
      '正在載入樓層、平面圖、鏡頭與標記資料。',
      6,
      result.loadedBytes,
      result.totalBytes
    );

    setCloudStatus(true,'雲端已連線');
    await openProject(p.id);

    setCloudLoadProgress(
      100,
      '專案開啟完成',
      `「${p.name}」已完成載入，共讀取 ${formatBytes(result.loadedBytes)}。`,
      6,
      result.loadedBytes,
      result.totalBytes
    );

    $('cloudLoadModal').querySelector('.cloud-load-card')?.classList.add('is-done');
    toast('已從 Google Drive 開啟專案');
    closeCloudLoadModal(700);
  }catch(err){
    if(String(err.message||'').includes('使用者已取消')){
      setCloudStatus(true,'雲端已連線');
      closeCloudLoadModal();
      toast('已取消讀取');
      return;
    }

    $('cloudLoadModal').querySelector('.cloud-load-card')?.classList.add('is-error');
    setCloudLoadProgress(
      Number($('cloudLoadPercent')?.textContent?.replace('%','')||0),
      '雲端專案讀取失敗',
      err.message||String(err),
      6,
      0,
      0
    );
    setCloudStatus(false,'讀取失敗');

    // 錯誤狀態保留，讓使用者看得到停在哪一步。
    if($('cancelCloudLoadBtn'))$('cancelCloudLoadBtn').textContent='關閉';
    console.warn('openCloudProject error:',err);
  }
}

async function saveProjectCloud(project){
  const revision=`${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
  project.cloudRevision=revision;
  setCloudStatus(false,'雲端儲存中',true);$('saveInfo').textContent='正在同步 Google Drive…';
  await formPost({action:'saveProject',projectId:project.id,projectName:project.name,siteType:project.siteType||'',address:project.address||'',version:APP_VERSION,revision,data:project});
  const list=await pollCloud(items=>items.some(p=>String(p.projectId)===String(project.id)&&String(p.revision||'')===revision&&p.driveFileId));
  cloudProjects=list;setCloudStatus(true,'雲端已儲存');$('saveInfo').textContent='本機＋Google Drive 已儲存';renderCloudProjectCards();
}

const viewer=$('viewer');
const scene3d=new THREE.Scene();scene3d.background=new THREE.Color(0x08111a);
const camera3d=new THREE.PerspectiveCamera(45,1,.1,500);camera3d.position.set(0,60,72);
const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.outputColorSpace=THREE.SRGBColorSpace;viewer.prepend(renderer.domElement);
const controls=new OrbitControls(camera3d,renderer.domElement);controls.enableDamping=true;controls.maxPolarAngle=Math.PI/2.02;controls.minDistance=10;controls.maxDistance=240;
scene3d.add(new THREE.HemisphereLight(0xd5f1ff,0x17212b,1.8));const dl=new THREE.DirectionalLight(0xffffff,1.2);dl.position.set(30,70,40);scene3d.add(dl);
const floorRoot=new THREE.Group(),environmentRoot=new THREE.Group(),cameraRoot=new THREE.Group(),markRoot=new THREE.Group(),draftRoot=new THREE.Group();scene3d.add(floorRoot,environmentRoot,cameraRoot,markRoot,draftRoot);
const raycaster=new THREE.Raycaster(),mouse=new THREE.Vector2(),dragPlane=new THREE.Plane(new THREE.Vector3(0,1,0),0);

function clearGroup(g){while(g.children.length){const o=g.children[0];g.remove(o);o.traverse?.(n=>{n.geometry?.dispose?.();if(n.material){(Array.isArray(n.material)?n.material:[n.material]).forEach(m=>{m.map?.dispose?.();m.dispose?.()})}})}}
function resize(){const w=Math.max(1,viewer.clientWidth),h=Math.max(1,viewer.clientHeight);camera3d.aspect=w/h;camera3d.updateProjectionMatrix();renderer.setSize(w,h,false)}
window.addEventListener('resize',resize);(function loop(){
  requestAnimationFrame(loop);
  controls.update();

  const t=performance.now()/1000;
  newCameraStars.forEach(marker=>{
    // 增設星星 / 故障驚嘆號都永遠朝向觀看鏡頭並閃爍。
    marker.quaternion.copy(camera3d.quaternion);
    const pulse=1+Math.sin(t*5.2)*.16;
    marker.scale.setScalar(pulse);
    marker.visible=Math.sin(t*9)>-.65;
    const face=marker.children?.[0];
    if(face?.material)face.material.opacity=.78+(Math.sin(t*6.5)+1)*.11;
  });

  renderer.render(scene3d,camera3d);
})();
function resetView(){camera3d.position.set(0,60,72);controls.target.set(0,0,0);controls.update();$('modeBadge').textContent='3D'}
function topView(){camera3d.position.set(0,120,.01);controls.target.set(0,0,0);controls.update();$('modeBadge').textContent='俯視'}
function zoom(f){const d=camera3d.position.clone().sub(controls.target).multiplyScalar(f);camera3d.position.copy(controls.target.clone().add(d));controls.update()}
function worldSize(){const p=currentScene?.plan,r=p?.height&&p?.width?p.height/p.width:.72;return{w:100,h:100*r}}
function buildFloor(){clearGroup(floorRoot);floorPlane=null;if(!currentScene?.plan?.dataUrl)return;const {w,h}=worldSize();const t=new THREE.TextureLoader().load(currentScene.plan.dataUrl);t.colorSpace=THREE.SRGBColorSpace;t.center.set(.5,.5);t.rotation=THREE.MathUtils.degToRad(Number(currentScene.plan.rotation||0));const m=new THREE.MeshBasicMaterial({map:t,transparent:true,opacity:Number(currentScene.plan.opacity??1),side:THREE.DoubleSide});floorPlane=new THREE.Mesh(new THREE.PlaneGeometry(w,h),m);floorPlane.rotation.x=-Math.PI/2;floorRoot.add(floorPlane);const grid=new THREE.GridHelper(Math.max(w,h),20,0x294255,0x172938);grid.position.y=.02;floorRoot.add(grid)}


function pathOffsetPairs(points,half,closed){
  const left=[],right=[],n=points.length;
  const norm=(a,b)=>{
    const dx=b.x-a.x,dz=b.z-a.z,len=Math.hypot(dx,dz)||1;
    return {x:-dz/len,z:dx/len};
  };
  for(let i=0;i<n;i++){
    let offset;
    if(!closed&&i===0){
      const q=norm(points[0],points[1]);offset={x:q.x*half,z:q.z*half};
    }else if(!closed&&i===n-1){
      const q=norm(points[n-2],points[n-1]);offset={x:q.x*half,z:q.z*half};
    }else{
      const prev=norm(points[(i-1+n)%n],points[i]);
      const next=norm(points[i],points[(i+1)%n]);
      let mx=prev.x+next.x,mz=prev.z+next.z,ml=Math.hypot(mx,mz);
      if(ml<1e-5){
        offset={x:next.x*half,z:next.z*half};
      }else{
        mx/=ml;mz/=ml;
        let denom=mx*next.x+mz*next.z;
        if(Math.abs(denom)<.2)denom=denom<0?-.2:.2;
        let scale=half/denom;
        const limit=half*4;
        scale=Math.max(-limit,Math.min(limit,scale));
        offset={x:mx*scale,z:mz*scale};
      }
    }
    left.push({x:points[i].x+offset.x,z:points[i].z+offset.z});
    right.push({x:points[i].x-offset.x,z:points[i].z-offset.z});
  }
  return {left,right};
}

function buildContinuousWallGeometry(o){
  const points=o.points||[],closed=!!o.closed,half=Number(o.thickness||.18)/2,height=Number(o.height||2.8);
  if(points.length<2)return new THREE.BoxGeometry(.1,.1,.1);

  const {left,right}=pathOffsetPairs(points,half,closed),verts=[],indices=[];
  for(let i=0;i<points.length;i++){
    verts.push(
      left[i].x,0,left[i].z,
      left[i].x,height,left[i].z,
      right[i].x,0,right[i].z,
      right[i].x,height,right[i].z
    );
  }

  const quad=(a,b,c,d)=>indices.push(a,b,c,a,c,d);
  const segCount=closed?points.length:points.length-1;
  for(let i=0;i<segCount;i++){
    const j=(i+1)%points.length,ib=i*4,jb=j*4;
    quad(ib+1,jb+1,jb+3,ib+3);
    quad(ib,ib+1,jb+1,jb);
    quad(ib+2,jb+2,jb+3,ib+3);
    quad(ib,jb,jb+2,ib+2);
  }
  if(!closed){
    quad(0,2,3,1);
    const b=(points.length-1)*4;
    quad(b,b+1,b+3,b+2);
  }

  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.Float32BufferAttribute(verts,3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function wallPathLength(o){
  const pts=o.points||[];
  if(pts.length<2)return 0;
  let total=0;
  const count=o.closed?pts.length:pts.length-1;
  for(let i=0;i<count;i++){
    const a=pts[i],b=pts[(i+1)%pts.length];
    total+=Math.hypot(b.x-a.x,b.z-a.z);
  }
  return total;
}

function renderWallDraft(){
  clearGroup(draftRoot);
  if(!draftWall.points.length)return;

  const pts=[...draftWall.points];
  if(draftWall.mousePoint)pts.push(draftWall.mousePoint);

  if(pts.length>=2){
    const linePts=pts.map(p=>new THREE.Vector3(p.x,.12,p.z));
    const line=new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(linePts),
      new THREE.LineBasicMaterial({color:0xf59e0b,transparent:true,opacity:.95})
    );
    draftRoot.add(line);
  }

  draftWall.points.forEach((p,i)=>{
    const dot=new THREE.Mesh(
      new THREE.SphereGeometry(i===0?.28:.20,14,12),
      new THREE.MeshStandardMaterial({color:i===0?0x22d3ee:0xf59e0b,emissive:i===0?0x073642:0x3b2500})
    );
    dot.position.set(p.x,.14,p.z);
    draftRoot.add(dot);
  });
}

function screenDistanceToWorldPoint(evt,p){
  const rect=renderer.domElement.getBoundingClientRect();
  const v=new THREE.Vector3(p.x,0,p.z).project(camera3d);
  const sx=rect.left+(v.x+1)*rect.width/2;
  const sy=rect.top+(1-v.y)*rect.height/2;
  return Math.hypot(evt.clientX-sx,evt.clientY-sy);
}

function finishWall(closed=false){
  if(draftWall.points.length<2){
    toast('牆體至少需要兩個點位');
    return;
  }
  if(closed&&draftWall.points.length<3){
    toast('封閉牆體至少需要三個點位');
    return;
  }

  const points=draftWall.points.map(p=>({x:+p.x.toFixed(3),z:+p.z.toFixed(3)}));
  const n=(currentScene.obstacles||[]).filter(o=>o.type==='wallpath'||o.type==='wall').length+1;
  const o={
    id:uid('wallpath'),
    type:'wallpath',
    name:`牆體-${String(n).padStart(2,'0')}`,
    points,
    closed,
    height:2.8,
    thickness:.18,
    fixed:true,
    hidden:false,
    occludes:true,
    angle:0,
    length:0,
    width:.18,
    depth:.18
  };
  o.length=+wallPathLength(o).toFixed(2);
  currentScene.obstacles.push(o);
  selected={kind:'obstacle',id:o.id};

  draftWall={points:[],mousePoint:null};
  setMode('select');
  renderWallDraft();
  renderObjects();
  showProperties();
  saveProject(false);
}

function obstacleColor(type){return type==='wall'?0x8b98a5:type==='column'?0x9aa6b2:type==='car'?0xe5e7eb:type==='motorcycle'?0x2563eb:0x94a3b8}
function makeObstacle(o){
  const g=new THREE.Group();
  g.userData={kind:'obstacle',id:o.id};

  if(o.type==='wallpath'){
    const geo=buildContinuousWallGeometry(o);
    const selectedWall=selected.kind==='obstacle'&&selected.id===o.id;
    const mat=new THREE.MeshStandardMaterial({
      color:selectedWall?0x93c5fd:0x6487a7,
      transparent:true,
      opacity:o.hidden?.18:.9,
      roughness:.65,
      emissive:selectedWall?0x0b2e55:0
    });
    const mesh=new THREE.Mesh(geo,mat);
    mesh.userData={kind:'obstacle',id:o.id};
    g.add(mesh);

    const edge=new THREE.LineSegments(
      new THREE.EdgesGeometry(geo,25),
      new THREE.LineBasicMaterial({color:selectedWall?0xffffff:0xdbeafe,transparent:true,opacity:.48})
    );
    edge.userData={kind:'obstacle',id:o.id};
    g.add(edge);
    return g;
  }

  g.position.set(o.x||0,0,o.z||0);
  g.rotation.y=THREE.MathUtils.degToRad(-(o.angle||0));
  const mat=new THREE.MeshStandardMaterial({
    color:obstacleColor(o.type),
    transparent:true,
    opacity:o.hidden?.18:.82,
    roughness:.72
  });
  let mesh;

  if(o.type==='wall'){
    mesh=new THREE.Mesh(
      new THREE.BoxGeometry(Number(o.length||8),Number(o.height||2.8),Number(o.thickness||.18)),
      mat
    );
    mesh.position.y=Number(o.height||2.8)/2;
  }else if(o.type==='column'){
    mesh=new THREE.Mesh(
      new THREE.BoxGeometry(Number(o.width||.8),Number(o.height||2.8),Number(o.depth||.8)),
      mat
    );
    mesh.position.y=Number(o.height||2.8)/2;
  }else if(o.type==='car'){
    mesh=new THREE.Mesh(new THREE.BoxGeometry(1.8,.85,4.2),mat);
    mesh.position.y=.65;
    const cabin=new THREE.Mesh(
      new THREE.BoxGeometry(1.55,.62,2),
      new THREE.MeshStandardMaterial({color:0xcbd5e1,transparent:true,opacity:.78})
    );
    cabin.position.set(0,1.15,-.1);
    cabin.userData={kind:'obstacle',id:o.id};
    g.add(cabin);
  }else if(o.type==='motorcycle'){
    mesh=new THREE.Mesh(new THREE.BoxGeometry(.55,.65,1.8),mat);
    mesh.position.y=.45;
  }else{
    const w=Number(o.width||2.5),d=Number(o.depth||5);
    const pts=[
      new THREE.Vector3(-w/2,.03,-d/2),
      new THREE.Vector3(w/2,.03,-d/2),
      new THREE.Vector3(w/2,.03,d/2),
      new THREE.Vector3(-w/2,.03,d/2),
      new THREE.Vector3(-w/2,.03,-d/2)
    ];
    const line=new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({color:0xf8fafc,transparent:true,opacity:.8})
    );
    line.userData={kind:'obstacle',id:o.id};
    g.add(line);
    return g;
  }

  mesh.userData={kind:'obstacle',id:o.id};
  g.add(mesh);
  return g;
}
function raySeg(origin,dir,a,b){const rx=dir.x,rz=dir.z,sx=b.x-a.x,sz=b.z-a.z,qx=a.x-origin.x,qz=a.z-origin.z,den=rx*sz-rz*sx;if(Math.abs(den)<1e-7)return null;const t=(qx*sz-qz*sx)/den,u=(qx*rz-qz*rx)/den;return t>=0&&u>=0&&u<=1?t:null}
function obstacleSegments(){
  const out=[];
  const addRectEdges=(p)=>{
    for(let i=0;i<4;i++)out.push([p[i],p[(i+1)%4]]);
  };
  const wallSegmentRect=(a,b,thickness)=>{
    const dx=b.x-a.x,dz=b.z-a.z,len=Math.hypot(dx,dz)||1;
    const nx=-dz/len*(thickness/2),nz=dx/len*(thickness/2);
    return [
      {x:a.x+nx,z:a.z+nz},
      {x:b.x+nx,z:b.z+nz},
      {x:b.x-nx,z:b.z-nz},
      {x:a.x-nx,z:a.z-nz}
    ];
  };

  (currentScene?.obstacles||[]).forEach(o=>{
    if(o.hidden||o.occludes===false||o.type==='parking')return;

    // V2.17：連續牆依「實際牆厚」建立遮擋邊界，
    // 不再只拿牆中心線來切 FOV，避免視野在還沒碰到牆面時提前消失。
    if(o.type==='wallpath'){
      const pts=o.points||[];
      const count=o.closed?pts.length:pts.length-1;
      const thickness=Number(o.thickness||.18);
      for(let i=0;i<count;i++){
        const a=pts[i],b=pts[(i+1)%pts.length];
        if(a&&b)addRectEdges(wallSegmentRect(a,b,thickness));
      }
      return;
    }

    const rad=THREE.MathUtils.degToRad(Number(o.angle||0));
    const c=Math.cos(rad),s=Math.sin(rad);
    const tr=(x,z)=>({x:(o.x||0)+x*c-z*s,z:(o.z||0)+x*s+z*c});
    let hw=.4,hd=.4;

    if(o.type==='wall'){hw=Number(o.length||8)/2;hd=Number(o.thickness||.18)/2}
    else if(o.type==='column'){hw=Number(o.width||.8)/2;hd=Number(o.depth||.8)/2}
    else if(o.type==='car'){hw=.9;hd=2.1}
    else if(o.type==='motorcycle'){hw=.35;hd=.95}

    addRectEdges([tr(-hw,-hd),tr(hw,-hd),tr(hw,hd),tr(-hw,hd)]);
  });
  return out;
}
function getCameraPose(c){
  const yawDeg=Number(c.yaw||0);
  const yawRad=THREE.MathUtils.degToRad(yawDeg);
  // V2.17：完全沿用 V1.16 的鏡頭方向座標。
  // 鏡頭正面 = local +X；整組再依 yaw 做 -yaw 旋轉。
  const modelRotationY=-yawRad;
  const mountY=2.58;
  const muzzleOffsetX=1.19;
  return {yawDeg,yawRad,modelRotationY,mountY,muzzleOffsetX};
}

function getCameraOccludedFan(c,range,fov,samples,pose){
  const segs=obstacleSegments();
  const theta=pose.modelRotationY;
  const ct=Math.cos(theta),st=Math.sin(theta);

  // V1.16 鏡頭鏡片在 local +X。
  const ox=(c.x||0)+pose.muzzleOffsetX*ct;
  const oz=(c.z||0)-pose.muzzleOffsetX*st;
  const rays=[];

  for(let i=0;i<=samples;i++){
    const off=-fov/2+fov*i/samples;

    // 完全沿用 V1.16：local forward = +X，local Z = -sin(off)。
    const lx=Math.cos(off);
    const lz=-Math.sin(off);

    const dx=lx*ct+lz*st;
    const dz=-lx*st+lz*ct;

    let dist=range;
    for(const [a,b] of segs){
      const hit=raySeg({x:ox,z:oz},{x:dx,z:dz},a,b);
      if(hit!==null&&hit>.01&&hit<dist)dist=hit;
    }
    rays.push({off,dist});
  }
  return rays;
}

function cameraCoverage(c){
  const pre=LENS[String(c.lens)]||LENS['2.8'];
  const range=Number(c.range||pre.range);
  const fov=THREE.MathUtils.degToRad(pre.fov);
  const pose=getCameraPose(c);
  const rays=getCameraOccludedFan(c,range,fov,96,pose);

  const shape=new THREE.Shape();
  shape.moveTo(0,0);
  for(const ray of rays){
    // Shape 的 Y 在 rotateX(-90°) 後會成為 -Z，
    // 因此這裡使用 +sin(off)，正好對應 local Z = -sin(off)。
    shape.lineTo(Math.cos(ray.off)*ray.dist,Math.sin(ray.off)*ray.dist);
  }
  shape.closePath();

  const group=new THREE.Group();
  group.position.set(c.x||0,0,c.z||0);
  group.rotation.y=pose.modelRotationY;
  group.userData={kind:'camera-coverage',id:c.id};

  const coverage=new THREE.Mesh(
    new THREE.ShapeGeometry(shape).rotateX(-Math.PI/2),
    new THREE.MeshBasicMaterial({
      color:COLORS[c.status]||COLORS.existing,
      transparent:true,
      opacity:.24,
      side:THREE.DoubleSide,
      depthWrite:false
    })
  );
  // 視野真正從 V1.16 鏡片前端 local +X 開始。
  coverage.position.set(pose.muzzleOffsetX,.055,0);
  coverage.renderOrder=6;
  coverage.userData={kind:'camera-coverage',id:c.id};
  group.add(coverage);

  return group;
}
function createFivePointStarShape(outer=0.9,inner=0.4){
  const shape=new THREE.Shape();
  for(let i=0;i<10;i++){
    const r=i%2===0?outer:inner;
    const a=-Math.PI/2+i*Math.PI/5;
    const x=Math.cos(a)*r,y=Math.sin(a)*r;
    if(i===0)shape.moveTo(x,y);else shape.lineTo(x,y);
  }
  shape.closePath();
  return shape;
}

function makeNewCameraStar(c){
  const g=new THREE.Group();
  g.position.set(c.x||0,7,c.z||0);
  g.userData={kind:'new-camera-star',cameraId:c.id,baseScale:1};

  const star=new THREE.Mesh(
    new THREE.ShapeGeometry(createFivePointStarShape(1.0,.43)),
    new THREE.MeshBasicMaterial({
      color:0xffe600,
      transparent:true,
      opacity:.95,
      side:THREE.DoubleSide,
      depthTest:false
    })
  );
  star.renderOrder=20;
  star.userData={kind:'new-camera-star',cameraId:c.id};
  g.add(star);

  const glow=new THREE.Mesh(
    new THREE.CircleGeometry(1.18,32),
    new THREE.MeshBasicMaterial({
      color:0xffcc00,
      transparent:true,
      opacity:.14,
      side:THREE.DoubleSide,
      depthTest:false
    })
  );
  glow.position.z=-.02;
  glow.renderOrder=19;
  g.add(glow);

  const stem=new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0,-4.15,0),
      new THREE.Vector3(0,-.95,0)
    ]),
    new THREE.LineDashedMaterial({
      color:0xffe600,
      transparent:true,
      opacity:.48,
      dashSize:.28,
      gapSize:.18,
      depthTest:false
    })
  );
  stem.computeLineDistances();
  stem.renderOrder=18;
  g.add(stem);

  newCameraStars.push(g);
  return g;
}

function makeFaultCameraMarker(c){
  const g=new THREE.Group();
  g.position.set(c.x||0,7,c.z||0);
  g.userData={kind:'fault-camera-marker',cameraId:c.id,baseScale:1};

  const badge=new THREE.Mesh(
    new THREE.CircleGeometry(1.05,32),
    new THREE.MeshBasicMaterial({
      color:0xff5a1f,
      transparent:true,
      opacity:.93,
      side:THREE.DoubleSide,
      depthTest:false
    })
  );
  badge.renderOrder=20;
  g.add(badge);

  const bar=new THREE.Mesh(
    new THREE.BoxGeometry(.24,1.05,.06),
    new THREE.MeshBasicMaterial({color:0xffffff,depthTest:false})
  );
  bar.position.set(0,.20,.04);
  bar.renderOrder=21;
  g.add(bar);

  const dot=new THREE.Mesh(
    new THREE.CircleGeometry(.16,20),
    new THREE.MeshBasicMaterial({color:0xffffff,depthTest:false})
  );
  dot.position.set(0,-.55,.05);
  dot.renderOrder=21;
  g.add(dot);

  const glow=new THREE.Mesh(
    new THREE.CircleGeometry(1.28,32),
    new THREE.MeshBasicMaterial({
      color:0xff7a33,
      transparent:true,
      opacity:.14,
      side:THREE.DoubleSide,
      depthTest:false
    })
  );
  glow.position.z=-.03;
  glow.renderOrder=19;
  g.add(glow);

  const stem=new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0,-4.15,0),
      new THREE.Vector3(0,-1.05,0)
    ]),
    new THREE.LineDashedMaterial({
      color:0xff6a2a,
      transparent:true,
      opacity:.55,
      dashSize:.28,
      gapSize:.18,
      depthTest:false
    })
  );
  stem.computeLineDistances();
  stem.renderOrder=18;
  g.add(stem);

  // 與新增星星共用 billboard / 閃爍動畫陣列。
  newCameraStars.push(g);
  return g;
}

function makeCamera(c){
  const isSelected=selected.kind==='camera'&&selected.id===c.id;
  const color=COLORS[c.status]||COLORS.existing;
  const pose=getCameraPose(c);

  const g=new THREE.Group();
  g.position.set(c.x||0,0,c.z||0);
  g.rotation.y=pose.modelRotationY;
  g.userData={kind:'camera',id:c.id};

  const bodyMat=new THREE.MeshStandardMaterial({color:isSelected?0xf8fafc:color,metalness:.24,roughness:.48,emissive:isSelected?0x223344:0});
  const shellMat=new THREE.MeshStandardMaterial({color:isSelected?0xffffff:0xe5e7eb,metalness:.22,roughness:.50,emissive:isSelected?0x223344:0});
  const darkMat=new THREE.MeshStandardMaterial({color:0x2a313d,metalness:.16,roughness:.55});
  const lensMat=new THREE.MeshStandardMaterial({color:0x111827,metalness:.72,roughness:.14});
  const glassMat=new THREE.MeshStandardMaterial({color:0x9fb9ff,roughness:.04,metalness:.76,transparent:true,opacity:.90,emissive:0x1d4ed8,emissiveIntensity:.18});
  const standMat=new THREE.MeshStandardMaterial({color:0x6b7280,roughness:.62,metalness:.20});
  const screwMat=new THREE.MeshStandardMaterial({color:0xa8b1bd,roughness:.45,metalness:.55});

  // 直接採用 V1.16 模型座標：鏡頭沿 local +X 朝前。
  const hood=new THREE.Mesh(new THREE.BoxGeometry(1.74,.62,1.10),shellMat);
  hood.position.set(-.05,2.92,0);hood.scale.set(1,1,.95);hood.userData=g.userData;g.add(hood);

  const hoodCut=new THREE.Mesh(new THREE.BoxGeometry(1.18,.40,.82),new THREE.MeshStandardMaterial({color:0x0f172a,roughness:.92,metalness:0}));
  hoodCut.position.set(-.30,2.86,0);hoodCut.userData=g.userData;g.add(hoodCut);

  const body=new THREE.Mesh(new THREE.BoxGeometry(1.55,.92,.92),bodyMat);
  body.position.set(-.02,2.58,0);body.userData=g.userData;g.add(body);

  const rearCap=new THREE.Mesh(new THREE.CylinderGeometry(.42,.46,.16,18),darkMat);
  rearCap.rotation.z=Math.PI/2;rearCap.position.set(-.82,2.56,0);rearCap.userData=g.userData;g.add(rearCap);

  const frontFrame=new THREE.Mesh(new THREE.BoxGeometry(.48,.86,.86),darkMat);
  frontFrame.position.set(.68,2.58,0);frontFrame.userData=g.userData;g.add(frontFrame);

  const bezel=new THREE.Mesh(new THREE.CylinderGeometry(.34,.34,.12,8),darkMat);
  bezel.rotation.z=Math.PI/2;bezel.position.set(.88,2.58,0);bezel.userData=g.userData;g.add(bezel);

  const lensBarrel=new THREE.Mesh(new THREE.CylinderGeometry(.24,.28,.34,24),lensMat);
  lensBarrel.rotation.z=Math.PI/2;lensBarrel.position.set(1.02,2.58,0);lensBarrel.userData=g.userData;g.add(lensBarrel);

  const lensGlass=new THREE.Mesh(new THREE.CylinderGeometry(.18,.18,.04,24),glassMat);
  lensGlass.rotation.z=Math.PI/2;lensGlass.position.set(1.19,2.58,0);lensGlass.userData=g.userData;g.add(lensGlass);

  const arm=new THREE.Mesh(new THREE.BoxGeometry(.46,.68,.26),bodyMat);
  arm.position.set(-.08,1.98,0);arm.userData=g.userData;g.add(arm);

  const yoke=new THREE.Mesh(new THREE.CylinderGeometry(.12,.12,.36,16),darkMat);
  yoke.rotation.x=Math.PI/2;yoke.position.set(-.08,2.18,0);yoke.userData=g.userData;g.add(yoke);

  const pole=new THREE.Mesh(new THREE.CylinderGeometry(.19,.21,1.62,18),standMat);
  pole.position.set(-.08,1.00,0);pole.userData=g.userData;g.add(pole);

  const collar=new THREE.Mesh(new THREE.CylinderGeometry(.28,.30,.24,18),darkMat);
  collar.position.set(-.08,.24,0);collar.userData=g.userData;g.add(collar);

  const base=new THREE.Mesh(new THREE.CylinderGeometry(.62,.66,.14,24),standMat);
  base.position.y=.07;base.userData=g.userData;g.add(base);

  for(const ang of [45,135,225,315]){
    const r=THREE.MathUtils.degToRad(ang);
    const bolt=new THREE.Mesh(new THREE.CylinderGeometry(.04,.04,.04,12),screwMat);
    bolt.position.set(-.08+Math.cos(r)*.42,.15,Math.sin(r)*.42);bolt.userData=g.userData;g.add(bolt);
  }
  for(const sy of[-.25,.25]){
    for(const sz of[-.25,.25]){
      const screw=new THREE.Mesh(new THREE.CylinderGeometry(.03,.03,.02,12),screwMat);
      screw.rotation.z=Math.PI/2;screw.position.set(.88,2.58+sy,sz);screw.userData=g.userData;g.add(screw);
    }
  }
  return g;
}
function makeMark(m){const g=new THREE.Group();g.position.set(m.x||0,.2,m.z||0);g.userData={kind:'mark',id:m.id};const a=new THREE.Mesh(new THREE.CylinderGeometry(.6,.6,.15,24),new THREE.MeshStandardMaterial({color:0xfacc15}));a.userData={kind:'mark',id:m.id};g.add(a);const s=new THREE.Mesh(new THREE.CylinderGeometry(.08,.08,2.6,12),new THREE.MeshStandardMaterial({color:0xfacc15}));s.position.y=1.35;s.userData={kind:'mark',id:m.id};g.add(s);return g}
function renderObjects(){
  clearGroup(environmentRoot);clearGroup(cameraRoot);clearGroup(markRoot);
  newCameraStars=[];
  if(!currentScene){renderWallDraft();return}
  currentScene.obstacles=currentScene.obstacles||[];
  currentScene.cameras=currentScene.cameras||[];
  currentScene.marks=currentScene.marks||[];
  currentScene.obstacles.forEach(o=>environmentRoot.add(makeObstacle(o)));
  currentScene.cameras.forEach(c=>{
    cameraRoot.add(makeCamera(c));
    if(c.showFov!==false)cameraRoot.add(cameraCoverage(c));
    if(c.status==='new')cameraRoot.add(makeNewCameraStar(c));
    if(c.status==='fault')cameraRoot.add(makeFaultCameraMarker(c));
  });
  currentScene.marks.forEach(m=>markRoot.add(makeMark(m)));
  refreshCounts();
  renderWallDraft();
}
function buildScene(){buildFloor();renderObjects();resize();if(currentScene?.plan)resetView()}
function planePoint(e){const r=renderer.domElement.getBoundingClientRect();mouse.x=((e.clientX-r.left)/r.width)*2-1;mouse.y=-((e.clientY-r.top)/r.height)*2+1;raycaster.setFromCamera(mouse,camera3d);const p=new THREE.Vector3();return raycaster.ray.intersectPlane(dragPlane,p)?p:null}
function hit(e){const r=renderer.domElement.getBoundingClientRect();mouse.x=((e.clientX-r.left)/r.width)*2-1;mouse.y=-((e.clientY-r.top)/r.height)*2+1;raycaster.setFromCamera(mouse,camera3d);for(const h of raycaster.intersectObjects([environmentRoot,cameraRoot,markRoot],true)){let o=h.object;while(o&&!o.userData?.kind)o=o.parent;if(o?.userData?.kind&&o.userData.kind!=='camera-coverage')return o.userData}return null}
function addObstacle(type,x,z){currentScene.obstacles=currentScene.obstacles||[];const n=currentScene.obstacles.filter(o=>o.type===type).length+1,labels={wall:'牆體',column:'柱子',car:'汽車',motorcycle:'機車',parking:'停車格'},o={id:uid('obs'),type,name:`${labels[type]}-${String(n).padStart(2,'0')}`,x,z,angle:0,fixed:type==='wall',hidden:false,occludes:type!=='parking',length:8,height:2.8,thickness:.18,width:type==='parking'?2.5:.8,depth:type==='parking'?5:.8};currentScene.obstacles.push(o);selected={kind:'obstacle',id:o.id};renderObjects();showProperties();saveProject(false)}
renderer.domElement.addEventListener('pointerdown',e=>{
  if(!currentScene?.plan)return;
  const p=planePoint(e);
  if(!p)return;

  if(mode==='add-wall'){
    // 已有三個以上節點，點回第一點（螢幕距離 20px 內）即封閉並完成。
    if(draftWall.points.length>=3&&screenDistanceToWorldPoint(e,draftWall.points[0])<=20){
      finishWall(true);
      return;
    }
    draftWall.points.push({x:+p.x.toFixed(3),z:+p.z.toFixed(3)});
    draftWall.mousePoint={x:+p.x.toFixed(3),z:+p.z.toFixed(3)};
    renderWallDraft();
    return;
  }

  if(mode==='add-column'){addObstacle('column',p.x,p.z);setMode('select');return}
  if(mode==='add-car'){addObstacle('car',p.x,p.z);setMode('select');return}
  if(mode==='add-motorcycle'){addObstacle('motorcycle',p.x,p.z);setMode('select');return}
  if(mode==='add-parking'){addObstacle('parking',p.x,p.z);setMode('select');return}
  if(mode==='add-camera'){addCamera(p.x,p.z);setMode('select');return}
  if(mode==='add-mark'){addMark(p.x,p.z);setMode('select');return}

  const h=hit(e);
  if(!h){
    selected={kind:null,id:null};
    showProperties();
    renderObjects();
    return;
  }

  selected={kind:h.kind,id:h.id};
  showProperties();
  renderObjects();

  const obj=
    h.kind==='camera'?currentScene.cameras.find(x=>x.id===h.id):
    h.kind==='mark'?currentScene.marks.find(x=>x.id===h.id):
    currentScene.obstacles.find(x=>x.id===h.id);

  if((h.kind==='camera'||h.kind==='obstacle')&&obj?.fixed)return;
  drag={...h,last:{x:p.x,z:p.z}};
  controls.enabled=false;
});
renderer.domElement.addEventListener('pointermove',e=>{
  const p=planePoint(e);

  if(mode==='add-wall'&&draftWall.points.length){
    if(p){
      draftWall.mousePoint={x:+p.x.toFixed(3),z:+p.z.toFixed(3)};
      renderWallDraft();
    }
    return;
  }

  if(!drag||!currentScene||!p)return;

  const arr=
    drag.kind==='camera'?currentScene.cameras:
    drag.kind==='mark'?currentScene.marks:
    currentScene.obstacles;

  const o=arr.find(x=>x.id===drag.id);
  if(!o)return;

  if(o.type==='wallpath'&&Array.isArray(o.points)){
    const dx=p.x-drag.last.x,dz=p.z-drag.last.z;
    o.points=o.points.map(pt=>({
      x:+(pt.x+dx).toFixed(3),
      z:+(pt.z+dz).toFixed(3)
    }));
    drag.last={x:p.x,z:p.z};
  }else{
    o.x=p.x;
    o.z=p.z;
    drag.last={x:p.x,z:p.z};
  }

  renderObjects();
});
renderer.domElement.addEventListener('pointerup',()=>{if(drag){drag=null;controls.enabled=true;saveProject(false)}});

window.addEventListener('keydown',e=>{
  if(mode!=='add-wall')return;

  if(e.key==='Enter'){
    e.preventDefault();
    finishWall(false);
  }else if(e.key==='Escape'){
    e.preventDefault();
    draftWall={points:[],mousePoint:null};
    setMode('select');
    renderWallDraft();
    toast('已取消牆體繪製');
  }
});


function newProject(data){return{id:uid('project'),name:data.name,siteType:data.siteType,address:data.address||'',note:data.note||'',createdAt:now(),updatedAt:now(),version:APP_VERSION,scenes:[]}}
function newScene(type,name){return{id:uid('scene'),type,name:name||type,plan:null,cameras:[],marks:[],obstacles:[]}}
async function saveProject(show=true){if(!currentProject)return;currentProject.name=$('projectNameInput').value.trim()||currentProject.name;currentProject.updatedAt=now();currentProject.version=APP_VERSION;await dbPut(clone(currentProject));$('editorProjectName').textContent=currentProject.name;$('saveInfo').textContent=`本機已儲存 ${new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`;if(show){try{if(APP_CONFIG.cloudApi?.enabled){await saveProjectCloud(currentProject);await dbPut(clone(currentProject))}toast('專案已儲存')}catch(err){setCloudStatus(false,'雲端儲存失敗');alert(`本機已儲存，但 Google Drive 同步失敗：${err.message}`)}}}
async function renderProjectCards(){const list=await dbAll(),el=$('projectCards');if(!list.length){el.innerHTML='<div class="empty-card">尚無專案。先按「建立新專案」，再建立樓層與匯入圖面。</div>';return}el.innerHTML=list.map(p=>{const n=(p.scenes||[]).reduce((s,x)=>s+(x.cameras?.length||0),0);return `<article class="project-card"><div><h3>${esc(p.name)}</h3><div class="meta">${esc(p.siteType||'')}<br>${p.scenes?.length||0} 個樓層・${n} 支鏡頭</div></div><div class="card-footer"><span class="meta">${new Date(p.updatedAt).toLocaleString()}</span><button data-open="${esc(p.id)}">開啟專案</button></div></article>`}).join('');el.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>openProject(b.dataset.open))}
async function openProject(id){const p=await dbGet(id);if(!p)return;currentProject=p;(currentProject.scenes||[]).forEach(s=>{s.cameras=s.cameras||[];s.marks=s.marks||[];s.obstacles=s.obstacles||[];s.obstacles.forEach(o=>{if((o.type==='wall'||o.type==='wallpath')&&typeof o.fixed!=='boolean')o.fixed=true;});});currentScene=p.scenes?.[0]||null;selected={kind:null,id:null};$('projectHome').classList.add('hidden');$('editorApp').classList.remove('hidden');$('projectNameInput').value=p.name;applyPanels();refreshEditor()}
async function goHome(){if(currentProject)await saveProject(false);currentProject=null;currentScene=null;$('editorApp').classList.add('hidden');$('projectHome').classList.remove('hidden');renderProjectCards()}
function renderSceneTree(){const el=$('sceneTree');if(!currentProject?.scenes?.length){el.innerHTML='<div class="empty-card" style="padding:18px">尚未建立樓層</div>';return}el.innerHTML=currentProject.scenes.map(s=>`<div class="scene-item ${currentScene?.id===s.id?'active':''}" data-id="${s.id}"><div class="scene-icon">${esc(s.type)}</div><div class="scene-text"><strong>${esc(s.name)}</strong><small>${s.plan?esc(s.plan.fileName):'尚未匯入圖面'}</small></div><span class="dot ${s.plan?'ready':''}"></span></div>`).join('');el.querySelectorAll('.scene-item').forEach(x=>x.onclick=()=>{currentScene=currentProject.scenes.find(s=>s.id===x.dataset.id);selected={kind:null,id:null};refreshEditor()})}
function refreshCounts(){if(!currentProject)return;const tc=currentProject.scenes.reduce((n,s)=>n+(s.cameras?.length||0),0),tm=currentProject.scenes.reduce((n,s)=>n+(s.marks?.length||0),0);$('sceneCount').textContent=currentProject.scenes.length;$('projectCameraCount').textContent=tc;$('projectMarkCount').textContent=tm;$('sceneCameraCount').textContent=currentScene?.cameras?.length||0;$('sceneMarkCount').textContent=currentScene?.marks?.length||0;$('sceneObstacleCount').textContent=currentScene?.obstacles?.length||0;$('cameraInfo').textContent=`鏡頭：${currentScene?.cameras?.length||0}`;$('planInfo').textContent=`圖面：${currentScene?.plan?.fileName||'—'}`;if($('camCountExisting'))$('camCountExisting').textContent=(currentScene?.cameras||[]).filter(c=>c.status==='existing').length;if($('camCountNew'))$('camCountNew').textContent=(currentScene?.cameras||[]).filter(c=>c.status==='new').length;if($('camCountFault'))$('camCountFault').textContent=(currentScene?.cameras||[]).filter(c=>c.status==='fault').length}
function refreshEditor(){if(!currentProject)return;$('editorProjectName').textContent=currentProject.name;$('editorSceneName').textContent=currentScene?.name||'尚未建立樓層';$('floorBadge').textContent=currentScene?.type||'—';$('emptyScene').classList.toggle('hidden',!!currentScene);$('emptyPlan').classList.toggle('hidden',!currentScene||!!currentScene.plan);renderSceneTree();refreshCounts();buildScene();showProperties();renderTools('project');if(currentScene){$('sceneNameInput').value=currentScene.name;$('sceneTypeInput').value=FLOORS.includes(currentScene.type)?currentScene.type:'自訂';$('planOpacityInput').value=currentScene.plan?.opacity??1;$('planOpacityOut').textContent=`${Math.round((currentScene.plan?.opacity??1)*100)}%`;$('planRotationInput').value=String(currentScene.plan?.rotation||0)}}
function showProperties(){['sceneProperties','cameraProperties','markProperties','obstacleProperties'].forEach(id=>$(id)?.classList.add('hidden'));if(selected.kind==='camera'){const c=currentScene?.cameras.find(x=>x.id===selected.id);if(!c)return;$('propertyTitle').textContent='監視器屬性';$('cameraProperties').classList.remove('hidden');$('camName').value=c.name;$('camStatus').value=c.status;$('camLens').value=c.lens;$('camYaw').value=c.yaw;$('camYawOut').textContent=`${c.yaw}°`;$('camRange').value=c.range;$('camRangeOut').textContent=`${c.range}m`;$('camHeight').value=c.height;$('camFixed').checked=!!c.fixed;$('camShowFov').checked=c.showFov!==false;$('camNote').value=c.note||'';return}if(selected.kind==='obstacle'){const o=currentScene?.obstacles?.find(x=>x.id===selected.id);if(!o)return;$('propertyTitle').textContent='環境物件屬性';$('obstacleProperties').classList.remove('hidden');$('obsName').value=o.name||'';$('obsType').value=o.type||'wall';$('obsAngle').value=o.angle||0;$('obsLength').value=o.type==='wallpath'?wallPathLength(o).toFixed(2):(o.length||8);$('obsWidth').value=o.width||.8;$('obsDepth').value=o.depth||.8;$('obsHeight').value=o.height||2.8;$('obsThickness').value=o.thickness||.18;$('obsOccludes').checked=o.occludes!==false;$('obsFixed').checked=!!o.fixed;$('obsHidden').checked=!!o.hidden;$('obsAngle').disabled=o.type==='wallpath';$('obsLength').disabled=o.type==='wallpath';return}if(selected.kind==='mark'){const m=currentScene?.marks.find(x=>x.id===selected.id);if(!m)return;$('propertyTitle').textContent='標記屬性';$('markProperties').classList.remove('hidden');$('markTitle').value=m.title;$('markType').value=m.type;$('markText').value=m.text||'';$('markPublic').checked=m.public!==false;return}$('obsAngle').disabled=false;$('obsLength').disabled=false;$('propertyTitle').textContent='場景屬性';$('sceneProperties').classList.remove('hidden')}
function addCamera(x,z){const n=currentScene.cameras.length+1,c={id:uid('cam'),name:`CAM-${currentScene.type}-${String(n).padStart(2,'0')}`,x,z,yaw:0,height:2.8,lens:'2.8',range:14,status:'existing',fixed:false,showFov:true,note:''};currentScene.cameras.push(c);selected={kind:'camera',id:c.id};renderObjects();showProperties();saveProject(false)}
function addMark(x,z){const n=currentScene.marks.length+1,m={id:uid('mark'),title:`標記-${String(n).padStart(2,'0')}`,type:'note',text:'',public:true,x,z};currentScene.marks.push(m);selected={kind:'mark',id:m.id};renderObjects();showProperties();saveProject(false)}
function setMode(m){const prev=mode;mode=m;if(prev==='add-wall'&&m!=='add-wall'&&draftWall.points.length===0)draftWall={points:[],mousePoint:null};const map={'add-camera':'請在平面圖上點選「監視器安裝位置」','add-mark':'請在平面圖上點選「標記位置」','add-wall':'連續牆體：依序點選路徑；點回第一點自動封閉完成；Enter 結束開放牆；Esc 取消','add-column':'請點選柱子位置','add-car':'請點選汽車位置','add-motorcycle':'請點選機車位置','add-parking':'請點選停車格位置'};const text=map[m]||'';$('modeHint').textContent=text;$('modeHint').classList.toggle('hidden',!text);controls.enabled=m==='select'&&!drag;renderWallDraft()}

function syncCam(){const c=currentScene?.cameras.find(x=>x.id===selected.id);if(!c)return;const prevLens=c.lens;c.name=$('camName').value||c.name;c.status=$('camStatus').value;c.lens=$('camLens').value;c.yaw=+$('camYaw').value;c.range=+$('camRange').value;c.height=+$('camHeight').value||2.8;c.fixed=$('camFixed').checked;c.showFov=$('camShowFov').checked;c.note=$('camNote').value;if(prevLens!==c.lens){const p=LENS[c.lens]||LENS['2.8'];c.range=p.range;$('camRange').value=p.range}$('camYawOut').textContent=`${c.yaw}°`;$('camRangeOut').textContent=`${c.range}m`;renderObjects()}
['camName','camStatus','camLens','camYaw','camRange','camHeight','camFixed','camShowFov','camNote'].forEach(id=>{$(id).addEventListener('input',syncCam);$(id).addEventListener('change',syncCam)});
function syncMark(){const m=currentScene?.marks.find(x=>x.id===selected.id);if(!m)return;m.title=$('markTitle').value||m.title;m.type=$('markType').value;m.text=$('markText').value;m.public=$('markPublic').checked}
['markTitle','markType','markText','markPublic'].forEach(id=>{$(id).addEventListener('input',syncMark);$(id).addEventListener('change',syncMark)});
function syncObstacle(){const o=currentScene?.obstacles?.find(x=>x.id===selected.id);if(!o)return;o.name=$('obsName').value||o.name;if(o.type!=='wallpath'){o.type=$('obsType').value;o.angle=+$('obsAngle').value||0;o.length=+$('obsLength').value||8}o.width=+$('obsWidth').value||.8;o.depth=+$('obsDepth').value||.8;o.height=+$('obsHeight').value||2.8;o.thickness=+$('obsThickness').value||.18;o.occludes=$('obsOccludes').checked;o.fixed=$('obsFixed').checked;o.hidden=$('obsHidden').checked;if(o.type==='wallpath')o.length=+wallPathLength(o).toFixed(2);renderObjects()}
['obsName','obsType','obsAngle','obsLength','obsWidth','obsDepth','obsHeight','obsThickness','obsOccludes','obsFixed','obsHidden'].forEach(id=>{$(id).addEventListener('input',syncObstacle);$(id).addEventListener('change',syncObstacle)});

async function imageToData(file){return new Promise((resolve,reject)=>{const fr=new FileReader();fr.onload=()=>{const img=new Image();img.onload=()=>{const max=2200,s=Math.min(1,max/img.width),c=document.createElement('canvas');c.width=Math.round(img.width*s);c.height=Math.round(img.height*s);c.getContext('2d').drawImage(img,0,0,c.width,c.height);resolve({dataUrl:c.toDataURL('image/jpeg',.9),width:c.width,height:c.height})};img.onerror=reject;img.src=fr.result};fr.onerror=reject;fr.readAsDataURL(file)})}
async function pdfToData(file){const pdfjs=await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs');pdfjs.GlobalWorkerOptions.workerSrc='https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';const pdf=await pdfjs.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise,p=await pdf.getPage(1),v0=p.getViewport({scale:1}),s=Math.min(2,2200/v0.width),v=p.getViewport({scale:s}),c=document.createElement('canvas');c.width=Math.round(v.width);c.height=Math.round(v.height);await p.render({canvasContext:c.getContext('2d'),viewport:v}).promise;return{dataUrl:c.toDataURL('image/jpeg',.9),width:c.width,height:c.height}}
function parseDxf(text){const l=text.replace(/\r/g,'').split('\n'),pairs=[];for(let i=0;i+1<l.length;i+=2)pairs.push([+l[i].trim(),l[i+1].trim()]);const seg=[];for(let i=0;i<pairs.length;){const [c,v]=pairs[i];if(c===0&&v==='LINE'){let x1=0,y1=0,x2=0,y2=0;i++;while(i<pairs.length&&pairs[i][0]!==0){const [k,z]=pairs[i];if(k===10)x1=+z;else if(k===20)y1=+z;else if(k===11)x2=+z;else if(k===21)y2=+z;i++}seg.push([x1,y1,x2,y2]);continue}i++}return seg}
async function dxfToData(file){const s=parseDxf(await file.text());if(!s.length)throw new Error('DXF 未找到 LINE 線段，請先輸出成 PDF。');const xs=[],ys=[];s.forEach(a=>{xs.push(a[0],a[2]);ys.push(a[1],a[3])});const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys),sx=Math.max(1,maxX-minX),sy=Math.max(1,maxY-minY),W=1800,H=Math.max(900,Math.round(W*sy/sx)),pad=50,scale=Math.min((W-pad*2)/sx,(H-pad*2)/sy),c=document.createElement('canvas'),ctx=c.getContext('2d');c.width=W;c.height=H;ctx.fillStyle='#f7f7f3';ctx.fillRect(0,0,W,H);ctx.strokeStyle='#222';ctx.beginPath();s.forEach(([x1,y1,x2,y2])=>{ctx.moveTo(pad+(x1-minX)*scale,H-pad-(y1-minY)*scale);ctx.lineTo(pad+(x2-minX)*scale,H-pad-(y2-minY)*scale)});ctx.stroke();return{dataUrl:c.toDataURL('image/png'),width:W,height:H}}
async function importPlan(file){if(!currentScene)return;if(/\.dwg$/i.test(file.name)){alert('DWG 目前請先轉成 DXF 或 PDF。');return}let r;if(file.type.startsWith('image/'))r=await imageToData(file);else if(file.type==='application/pdf'||/\.pdf$/i.test(file.name))r=await pdfToData(file);else if(/\.dxf$/i.test(file.name))r=await dxfToData(file);else throw new Error('不支援此格式');currentScene.plan={fileName:file.name,dataUrl:r.dataUrl,width:r.width,height:r.height,opacity:1,rotation:0};await saveProject(false);refreshEditor();toast('圖面已匯入')}
$('planFileInput').onchange=async e=>{const f=e.target.files?.[0];if(!f)return;try{await importPlan(f)}catch(err){alert(err.message)}e.target.value=''};$('choosePlanBtn').onclick=()=>$('planFileInput').click();$('replacePlanBtn').onclick=()=>$('planFileInput').click();$('removePlanBtn').onclick=async()=>{if(!currentScene?.plan)return;if(confirm('移除此樓層圖面？')){currentScene.plan=null;await saveProject(false);refreshEditor()}};const dz=$('dropZone');['dragenter','dragover'].forEach(t=>dz.addEventListener(t,e=>{e.preventDefault();dz.classList.add('dragover')}));['dragleave','drop'].forEach(t=>dz.addEventListener(t,e=>{e.preventDefault();dz.classList.remove('dragover')}));dz.addEventListener('drop',e=>{const f=e.dataTransfer.files?.[0];if(f)importPlan(f)});


function cameraStatusLabel(status){
  return status==='new'?'增設':status==='fault'?'故障':'原建置';
}
function cameraStatusColor(status){
  return status==='new'?'#eab308':status==='fault'?'#f97316':'#dc2626';
}
function reportSceneList(scope){
  if(!currentProject)return [];
  if(scope==='all')return currentProject.scenes||[];
  return currentScene?[currentScene]:[];
}
function updateReportModalSummary(){
  const scenes=reportSceneList($('reportScope')?.value||'current');
  const cams=scenes.flatMap(s=>s.cameras||[]);
  $('reportProjectName').textContent=currentProject?.name||'—';
  $('reportFloorName').textContent=$('reportScope')?.value==='all'?'全部樓層':(currentScene?.name||'—');
  $('reportCameraCount').textContent=cams.length;
  $('reportNewCameraCount').textContent=cams.filter(c=>c.status==='new').length;
}
function openCameraReportModal(){
  if(!currentProject)return toast('請先開啟專案');
  if(!currentProject.scenes?.length)return toast('目前專案沒有樓層');
  $('reportScope').value='current';
  $('reportIncludeSnapshot').checked=true;
  $('reportIncludeNotes').checked=true;
  $('reportOnlyPublicMarks').checked=true;
  updateReportModalSummary();
  showModal('cameraReportModal');
}
function rendererSnapshotDataUrl(){
  try{
    renderer.render(scene3d,camera3d);
    return renderer.domElement.toDataURL('image/png',.92);
  }catch(err){
    console.warn('3D snapshot failed:',err);
    return '';
  }
}
function buildCameraReportHtml({autoPrint=false}={}){
  const scope=$('reportScope').value;
  const includeSnapshot=$('reportIncludeSnapshot').checked;
  const includeNotes=$('reportIncludeNotes').checked;
  const onlyPublicMarks=$('reportOnlyPublicMarks').checked;
  const scenes=reportSceneList(scope);
  const allCams=scenes.flatMap(s=>(s.cameras||[]).map(c=>({scene:s,camera:c})));
  const existing=allCams.filter(x=>x.camera.status==='existing').length;
  const added=allCams.filter(x=>x.camera.status==='new').length;
  const fault=allCams.filter(x=>x.camera.status==='fault').length;
  const snapshot=includeSnapshot?rendererSnapshotDataUrl():'';
  const generated=new Date().toLocaleString('zh-TW');

  const escHtml=v=>String(v??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

  const sceneSections=scenes.map(s=>{
    const cams=s.cameras||[];
    const marks=(s.marks||[]).filter(m=>!onlyPublicMarks||m.public!==false);
    const rows=cams.length?cams.map((c,i)=>`
      <tr>
        <td>${i+1}</td>
        <td>${escHtml(c.name)}</td>
        <td><span class="status-dot" style="background:${cameraStatusColor(c.status)}"></span>${cameraStatusLabel(c.status)}</td>
        <td>${escHtml(c.lens)} mm</td>
        <td>${escHtml(c.range)} m</td>
        <td>${escHtml(c.yaw)}°</td>
        <td>${escHtml(c.height)} m</td>
        <td>${c.fixed?'是':'否'}</td>
        ${includeNotes?`<td>${escHtml(c.note||'')}</td>`:''}
      </tr>`).join(''):`<tr><td colspan="${includeNotes?9:8}" class="empty-row">此樓層尚無監視器</td></tr>`;

    const markRows=marks.length?`
      <div class="marks">
        <h4>標記 / 說明</h4>
        ${marks.map(m=>`<div class="mark-item"><b>${escHtml(m.title||'標記')}</b><span>${escHtml(m.text||'')}</span></div>`).join('')}
      </div>`:'';

    return `
      <section class="floor-section">
        <div class="floor-title">
          <h2>${escHtml(s.type||'')}｜${escHtml(s.name||'')}</h2>
          <span>${cams.length} 支鏡頭</span>
        </div>
        <table>
          <thead><tr>
            <th>#</th><th>鏡頭名稱</th><th>狀態</th><th>焦段</th>
            <th>距離</th><th>方向</th><th>高度</th><th>固定</th>
            ${includeNotes?'<th>備註</th>':''}
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${markRows}
      </section>`;
  }).join('');

  const snapshotHtml=snapshot?`
    <section class="snapshot-section">
      <h2>3D 配置畫面</h2>
      <img src="${snapshot}" alt="3D CCTV 配置畫面">
      <p class="small">黃色閃爍星星代表「增設鏡頭」。</p>
    </section>`:'';

  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<title>${escHtml(currentProject.name)}｜CCTV 鏡頭配置報告</title>
<style>
  *{box-sizing:border-box}body{font-family:"Microsoft JhengHei","Noto Sans TC",sans-serif;margin:0;color:#18212b;background:#fff}
  .page{max-width:1180px;margin:auto;padding:28px}
  .head{border-bottom:3px solid #123a54;padding-bottom:14px;margin-bottom:18px}
  .head h1{margin:0 0 6px;font-size:27px}.head p{margin:2px 0;color:#5c6b77;font-size:12px}
  .summary{display:grid;grid-template-columns:repeat(4,1fr);gap:9px;margin:16px 0 20px}
  .summary div{border:1px solid #d5dee5;border-radius:8px;padding:10px;background:#f8fafc}
  .summary span{display:block;color:#667784;font-size:10px}.summary b{font-size:18px}
  .snapshot-section{page-break-inside:avoid;margin:20px 0}.snapshot-section h2,.floor-title h2{font-size:17px;margin:0 0 10px}
  .snapshot-section img{width:100%;max-height:590px;object-fit:contain;border:1px solid #d5dee5;background:#0b1520}
  .small{font-size:10px;color:#6c7a86}
  .floor-section{margin:24px 0;page-break-inside:auto}
  .floor-title{display:flex;justify-content:space-between;align-items:center;border-left:5px solid #1f7892;padding-left:10px;margin-bottom:9px}
  .floor-title span{font-size:11px;color:#5f7180}
  table{border-collapse:collapse;width:100%;font-size:10px}
  th,td{border:1px solid #cfd8df;padding:6px;vertical-align:top}th{background:#edf3f7;text-align:left;white-space:nowrap}
  .status-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px}
  .marks{margin-top:12px;border:1px solid #d9e1e6;border-radius:8px;padding:10px}.marks h4{margin:0 0 8px}
  .mark-item{display:flex;gap:12px;border-top:1px solid #edf1f4;padding:6px 0;font-size:10px}.mark-item:first-of-type{border-top:0}
  .mark-item b{min-width:120px}.empty-row{text-align:center;color:#74838e}
  .footer{margin-top:24px;padding-top:10px;border-top:1px solid #d7dee3;font-size:9px;color:#71808c}
  @media print{
    @page{size:A4 landscape;margin:10mm}
    .page{max-width:none;padding:0}
    .summary{break-inside:avoid}
    .snapshot-section{break-inside:avoid}
    tr{break-inside:avoid}
  }
</style>
</head>
<body>
<div class="page">
  <div class="head">
    <h1>${escHtml(currentProject.name)}｜CCTV 鏡頭配置報告</h1>
    <p>案場類型：${escHtml(currentProject.siteType||'')}</p>
    <p>地址：${escHtml(currentProject.address||'')}</p>
    <p>產生時間：${generated}｜系統版本：${APP_VERSION}</p>
  </div>

  <div class="summary">
    <div><span>鏡頭總數</span><b>${allCams.length}</b></div>
    <div><span>原建置</span><b>${existing}</b></div>
    <div><span>增設</span><b>${added}</b></div>
    <div><span>故障</span><b>${fault}</b></div>
  </div>

  ${snapshotHtml}
  ${sceneSections}

  <div class="footer">3D CCTV Planner｜此報告供監視器配置、視野與增設位置說明使用。</div>
</div>
<script>
  ${autoPrint?`window.addEventListener('load',()=>setTimeout(()=>window.print(),450));`:''}
</script>
</body>
</html>`;
}

function openCameraReportPreview(autoPrint=false){
  const report=buildCameraReportHtml({autoPrint});
  const win=window.open('','_blank');
  if(!win){
    alert('瀏覽器阻擋了報告視窗，請允許此網站開啟彈出視窗。');
    return;
  }
  win.document.open();
  win.document.write(report);
  win.document.close();
}

function renderTools(menu){const data={project:[['儲存專案','save'],['匯出專案','export'],['新增樓層','new-scene']],plan:[['匯入 / 更換圖面','plan'],['透明度 100%','op1'],['透明度 50%','op5']],environment:[['＋ 牆體','add-wall'],['＋ 柱子','add-column'],['＋ 汽車','add-car'],['＋ 機車','add-motorcycle'],['＋ 停車格','add-parking']],camera:[['＋ 新增監視器','add-camera'],['顯示全部視野','show'],['隱藏全部視野','hide'],['全部設為原建置','cams-existing'],['全部設為增設','cams-new']],mark:[['＋ 新增標記','add-mark']],measure:[['兩點實尺校正（下一階段）','todo']],view:[['3D','3d'],['俯視','top'],['重設視角','reset'],['專注模式','focus']],report:[['輸出鏡頭配置報告','camera-report']]};$('toolShelf').innerHTML=`<span class="tool-label">${menu.toUpperCase()}</span>`+(data[menu]||[]).map(([x,a])=>`<button data-act="${a}">${x}</button>`).join('');$('toolShelf').querySelectorAll('[data-act]').forEach(b=>b.onclick=()=>runTool(b.dataset.act))}
function runTool(a){if(a==='save')return saveProject();if(a==='export')return exportProject();if(a==='new-scene')return openSceneModal();if(a==='plan')return $('planFileInput').click();if(a==='op1'&&currentScene?.plan){currentScene.plan.opacity=1;buildFloor()}else if(a==='op5'&&currentScene?.plan){currentScene.plan.opacity=.5;buildFloor()}else if(a==='add-wall'){draftWall={points:[],mousePoint:null};setMode('add-wall');}else if(a==='add-column')setMode('add-column');else if(a==='add-car')setMode('add-car');else if(a==='add-motorcycle')setMode('add-motorcycle');else if(a==='add-parking')setMode('add-parking');else if(a==='add-camera')setMode('add-camera');else if(a==='add-mark')setMode('add-mark');else if(a==='show'){currentScene.cameras.forEach(c=>c.showFov=true);renderObjects()}else if(a==='hide'){currentScene.cameras.forEach(c=>c.showFov=false);renderObjects()}else if(a==='cams-existing'){currentScene.cameras.forEach(c=>c.status='existing');renderObjects()}else if(a==='cams-new'){currentScene.cameras.forEach(c=>c.status='new');renderObjects()}else if(a==='3d')resetView();else if(a==='top')topView();else if(a==='reset')resetView();else if(a==='focus')toggleFocus();else if(a==='camera-report')openCameraReportModal();else toast('此功能排在下一階段加入')}
document.querySelectorAll('.main-menu button').forEach(b=>b.onclick=()=>renderTools(b.dataset.menu));

function applyPanels(){const g=$('editorGrid');g.classList.toggle('left-collapsed',!!uiState.leftCollapsed);g.classList.toggle('right-collapsed',!!uiState.rightCollapsed);$('expandLeftBtn').classList.toggle('hidden',!uiState.leftCollapsed);$('expandRightBtn').classList.toggle('hidden',!uiState.rightCollapsed);requestAnimationFrame(resize)}
$('collapseLeftBtn').onclick=()=>{uiState.leftCollapsed=true;saveUIState();applyPanels()};$('expandLeftBtn').onclick=()=>{uiState.leftCollapsed=false;saveUIState();applyPanels()};$('collapseRightBtn').onclick=()=>{uiState.rightCollapsed=true;saveUIState();applyPanels()};$('expandRightBtn').onclick=()=>{uiState.rightCollapsed=false;saveUIState();applyPanels()};function toggleFocus(){document.body.classList.toggle('focus-mode');requestAnimationFrame(resize)}$('focusModeBtn').onclick=toggleFocus;
function showModal(id){$(id).classList.remove('hidden')}function hideModal(id){$(id).classList.add('hidden')}document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>hideModal(b.dataset.close));

$('reportScope')?.addEventListener('change',updateReportModalSummary);
$('previewCameraReportBtn')?.addEventListener('click',()=>openCameraReportPreview(false));
$('printCameraReportBtn')?.addEventListener('click',()=>openCameraReportPreview(true));

$('newProjectBtn').onclick=()=>showModal('newProjectModal');$('createProjectConfirmBtn').onclick=async()=>{const name=$('newProjectName').value.trim();if(!name)return alert('請輸入專案名稱');const p=newProject({name,siteType:$('newProjectType').value,address:$('newProjectAddress').value.trim(),note:$('newProjectNote').value.trim()});await dbPut(p);hideModal('newProjectModal');openProject(p.id)};
function openSceneModal(){if(!currentProject)return;$('newSceneType').value='B1';$('newSceneName').value='B1 地下停車場';showModal('newSceneModal')}$('addSceneBtn').onclick=openSceneModal;$('emptyAddSceneBtn').onclick=openSceneModal;$('newSceneType').onchange=()=>{const t=$('newSceneType').value;$('newSceneName').value=t==='自訂'?'':`${t} ${t.startsWith('B')?'地下停車場':'場景'}`};$('createSceneConfirmBtn').onclick=async()=>{const t=$('newSceneType').value,n=$('newSceneName').value.trim()||t,s=newScene(t,n);currentProject.scenes.push(s);currentScene=s;hideModal('newSceneModal');await saveProject(false);refreshEditor()};
$('backHomeBtn').onclick=goHome;$('saveProjectBtn').onclick=()=>saveProject();$('projectNameInput').onchange=()=>saveProject(false);$('sceneNameInput').onchange=async()=>{if(currentScene){currentScene.name=$('sceneNameInput').value.trim()||currentScene.name;await saveProject(false);refreshEditor()}};$('sceneTypeInput').onchange=async()=>{if(currentScene){currentScene.type=$('sceneTypeInput').value;await saveProject(false);refreshEditor()}};$('planOpacityInput').oninput=()=>{if(currentScene?.plan){currentScene.plan.opacity=+$('planOpacityInput').value;$('planOpacityOut').textContent=`${Math.round(currentScene.plan.opacity*100)}%`;if(floorPlane)floorPlane.material.opacity=currentScene.plan.opacity}};$('planRotationInput').onchange=async()=>{if(currentScene?.plan){currentScene.plan.rotation=+$('planRotationInput').value;await saveProject(false);buildFloor()}};
$('deleteObstacleBtn').onclick=async()=>{const o=currentScene?.obstacles?.find(x=>x.id===selected.id);if(o&&confirm(`刪除環境物件「${o.name}」？`)){currentScene.obstacles=currentScene.obstacles.filter(x=>x.id!==o.id);selected={kind:null,id:null};await saveProject(false);renderObjects();showProperties()}};$('deleteCameraBtn').onclick=async()=>{const c=currentScene?.cameras.find(x=>x.id===selected.id);if(c&&confirm(`刪除鏡頭「${c.name}」？`)){currentScene.cameras=currentScene.cameras.filter(x=>x.id!==c.id);selected={kind:null,id:null};await saveProject(false);renderObjects();showProperties()}};$('deleteMarkBtn').onclick=async()=>{const m=currentScene?.marks.find(x=>x.id===selected.id);if(m&&confirm(`刪除標記「${m.title}」？`)){currentScene.marks=currentScene.marks.filter(x=>x.id!==m.id);selected={kind:null,id:null};await saveProject(false);renderObjects();showProperties()}};
$('zoomInBtn').onclick=()=>zoom(.82);$('zoomOutBtn').onclick=()=>zoom(1.22);$('resetViewBtn').onclick=resetView;$('topViewBtn').onclick=topView;$('view3dBtn').onclick=resetView;$('fullscreenBtn').onclick=()=>!document.fullscreenElement?viewer.requestFullscreen?.():document.exitFullscreen?.();
async function exportProject(){if(!currentProject)return;await saveProject(false);const blob=new Blob([JSON.stringify({format:'UTOP-CCTV3D',formatVersion:2,appVersion:APP_VERSION,project:clone(currentProject)},null,2)],{type:'application/json'}),u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download=`${currentProject.name.replace(/[\\/:*?"<>|]+/g,'-')}-${APP_VERSION}.cctv3d`;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)}$('exportProjectBtn').onclick=exportProject;
$('importProjectBtn').onclick=()=>$('importProjectFile').click();$('importProjectFile').onchange=async e=>{const f=e.target.files?.[0];if(!f)return;try{const x=JSON.parse(await f.text()),p=x.project||x;if(!p?.name)throw new Error('格式不正確');p.id=uid('project');p.updatedAt=now();p.version=APP_VERSION;await dbPut(p);renderProjectCards();toast('專案已匯入')}catch(err){alert(`匯入失敗：${err.message}`)}e.target.value=''};$('deleteProjectBtn').onclick=async()=>{if(currentProject&&confirm(`確定刪除專案「${currentProject.name}」？`)){await dbDelete(currentProject.id);goHome()}};$('refreshProjectListBtn').onclick=renderProjectCards;if($('refreshCloudProjectsBtn'))$('refreshCloudProjectsBtn').onclick=()=>{activeApiUrl='';renderCloudProjectCards()};



if($('cancelCloudLoadBtn'))$('cancelCloudLoadBtn').onclick=()=>{
  const stage=$('cloudLoadStage')?.textContent||'';
  if(stage.includes('失敗')||stage.includes('完成')){
    closeCloudLoadModal();
    $('cancelCloudLoadBtn').textContent='取消讀取';
    return;
  }
  cloudLoadCancelRequested=true;
  $('cancelCloudLoadBtn').disabled=true;
  $('cancelCloudLoadBtn').textContent='正在取消…';
  setTimeout(()=>{
    $('cancelCloudLoadBtn').disabled=false;
    $('cancelCloudLoadBtn').textContent='取消讀取';
  },1000);
};

if($('retryCloudBtn'))$('retryCloudBtn').onclick=()=>{activeApiUrl='';renderCloudProjectCards();};
if($('copyCloudDiagBtn'))$('copyCloudDiagBtn').onclick=async()=>{
  const text=$('cloudDiagnosticsText')?.textContent||'';
  try{await navigator.clipboard.writeText(text);toast('診斷資訊已複製');}
  catch{prompt('複製診斷資訊：',text);}
};

(async function startup(){
  await openDb();
  await renderProjectCards();
  applyPanels();
  resize();
  $('statusText').textContent=`${APP_CONFIG.appName} ${APP_VERSION}｜本機＋Google Drive 編輯版`;
  await renderCloudProjectCards();
})().catch(e=>{
  console.error(e);
  setCloudDiagnostics(`系統啟動錯誤：${e.message}`,e.stack||'');
  alert(`系統啟動失敗：${e.message}`);
});
