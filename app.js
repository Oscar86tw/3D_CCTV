import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { APP_CONFIG } from './config.js?v=2.3';

const $=id=>document.getElementById(id);
const APP_VERSION=APP_CONFIG.version;
const DB_NAME='UTOP_CCTV_V2';
const STORE_NAME='projects';
const UI_KEY='utop-cctv-v2-ui';
const API_CACHE_KEY='utop-cctv-v23-api-url';
let cloudProjects=[];
let cloudConnected=false;
let activeApiUrl='';
let jsonpSeq=0;
const LENS={'2.8':{fov:102,range:14},'3.6':{fov:84,range:17},'4':{fov:76,range:18},'6':{fov:53,range:25},'8':{fov:40,range:32}};
const COLORS={existing:0xdc2626,new:0xeab308,fault:0xf97316};
const FLOORS=['RF','R1F','1MF','1F','2F','3F','B1','B2','B3','B4','B5','B6','自訂'];
let db,currentProject=null,currentScene=null,selected={kind:null,id:null},mode='select',drag=null,floorPlane=null;
let uiState=loadUIState();

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
  const parts=[];let offset=0;const limit=100000;
  for(let i=0;i<160;i++){
    const r=await jsonpGet('getProjectChunk',{projectId,offset,limit},30000);
    if(!r?.ok)throw new Error(r?.message||'分段讀取失敗');parts.push(String(r.chunk||''));offset=Number(r.nextOffset||offset);
    $('statusText').textContent=`正在讀取雲端專案… ${Math.round(Number(r.progress||0)*100)}%`;
    if(r.done){const wrapper=JSON.parse(parts.join(''));return wrapper.project||wrapper.data||wrapper;}
  }
  throw new Error('雲端專案分段數量超過上限');
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
    if(apiVersion!=='2.2'){
      console.warn(`目前 Apps Script API 版本：${apiVersion}，前端：2.2`);
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
  try{
    setCloudStatus(false,'讀取中',true);
    const p=await getCloudProjectChunked(projectId);if(!p?.name)throw new Error('雲端專案格式不正確');
    await dbPut(p);setCloudStatus(true,'雲端已連線');await openProject(p.id);toast('已從 Google Drive 開啟專案');
  }catch(err){setCloudStatus(false,'讀取失敗');alert(`雲端讀取失敗：${err.message}`)}
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
const floorRoot=new THREE.Group(),cameraRoot=new THREE.Group(),markRoot=new THREE.Group();scene3d.add(floorRoot,cameraRoot,markRoot);
const raycaster=new THREE.Raycaster(),mouse=new THREE.Vector2(),dragPlane=new THREE.Plane(new THREE.Vector3(0,1,0),0);

function clearGroup(g){while(g.children.length){const o=g.children[0];g.remove(o);o.traverse?.(n=>{n.geometry?.dispose?.();if(n.material){(Array.isArray(n.material)?n.material:[n.material]).forEach(m=>{m.map?.dispose?.();m.dispose?.()})}})}}
function resize(){const w=Math.max(1,viewer.clientWidth),h=Math.max(1,viewer.clientHeight);camera3d.aspect=w/h;camera3d.updateProjectionMatrix();renderer.setSize(w,h,false)}
window.addEventListener('resize',resize);(function loop(){requestAnimationFrame(loop);controls.update();renderer.render(scene3d,camera3d)})();
function resetView(){camera3d.position.set(0,60,72);controls.target.set(0,0,0);controls.update();$('modeBadge').textContent='3D'}
function topView(){camera3d.position.set(0,120,.01);controls.target.set(0,0,0);controls.update();$('modeBadge').textContent='俯視'}
function zoom(f){const d=camera3d.position.clone().sub(controls.target).multiplyScalar(f);camera3d.position.copy(controls.target.clone().add(d));controls.update()}
function worldSize(){const p=currentScene?.plan,r=p?.height&&p?.width?p.height/p.width:.72;return{w:100,h:100*r}}
function buildFloor(){clearGroup(floorRoot);floorPlane=null;if(!currentScene?.plan?.dataUrl)return;const {w,h}=worldSize();const t=new THREE.TextureLoader().load(currentScene.plan.dataUrl);t.colorSpace=THREE.SRGBColorSpace;t.center.set(.5,.5);t.rotation=THREE.MathUtils.degToRad(Number(currentScene.plan.rotation||0));const m=new THREE.MeshBasicMaterial({map:t,transparent:true,opacity:Number(currentScene.plan.opacity??1),side:THREE.DoubleSide});floorPlane=new THREE.Mesh(new THREE.PlaneGeometry(w,h),m);floorPlane.rotation.x=-Math.PI/2;floorRoot.add(floorPlane);const grid=new THREE.GridHelper(Math.max(w,h),20,0x294255,0x172938);grid.position.y=.02;floorRoot.add(grid)}
function makeCamera(c){const g=new THREE.Group();g.position.set(c.x||0,1.4,c.z||0);g.rotation.y=THREE.MathUtils.degToRad(-(c.yaw||0));g.userData={kind:'camera',id:c.id};const color=COLORS[c.status]||COLORS.existing;const b=new THREE.Mesh(new THREE.BoxGeometry(1.2,.65,.8),new THREE.MeshStandardMaterial({color}));b.position.y=.35;g.add(b);const lens=new THREE.Mesh(new THREE.CylinderGeometry(.22,.22,.45,20),new THREE.MeshStandardMaterial({color:0x111827}));lens.rotation.x=Math.PI/2;lens.position.set(0,.35,-.58);g.add(lens);if(c.showFov!==false){const pre=LENS[String(c.lens)]||LENS['2.8'],range=Number(c.range||pre.range),fov=THREE.MathUtils.degToRad(pre.fov),half=Math.tan(fov/2)*range;const s=new THREE.Shape();s.moveTo(0,0);s.lineTo(-half,-range);s.lineTo(half,-range);s.closePath();const fm=new THREE.Mesh(new THREE.ShapeGeometry(s).rotateX(-Math.PI/2),new THREE.MeshBasicMaterial({color,transparent:true,opacity:.16,side:THREE.DoubleSide,depthWrite:false}));fm.position.y=.06;g.add(fm)}return g}
function makeMark(m){const g=new THREE.Group();g.position.set(m.x||0,.2,m.z||0);g.userData={kind:'mark',id:m.id};const a=new THREE.Mesh(new THREE.CylinderGeometry(.6,.6,.15,24),new THREE.MeshStandardMaterial({color:0xfacc15}));g.add(a);const s=new THREE.Mesh(new THREE.CylinderGeometry(.08,.08,2.6,12),new THREE.MeshStandardMaterial({color:0xfacc15}));s.position.y=1.35;g.add(s);return g}
function renderObjects(){clearGroup(cameraRoot);clearGroup(markRoot);(currentScene?.cameras||[]).forEach(c=>cameraRoot.add(makeCamera(c)));(currentScene?.marks||[]).forEach(m=>markRoot.add(makeMark(m)));refreshCounts()}
function buildScene(){buildFloor();renderObjects();resize();if(currentScene?.plan)resetView()}
function planePoint(e){const r=renderer.domElement.getBoundingClientRect();mouse.x=((e.clientX-r.left)/r.width)*2-1;mouse.y=-((e.clientY-r.top)/r.height)*2+1;raycaster.setFromCamera(mouse,camera3d);const p=new THREE.Vector3();return raycaster.ray.intersectPlane(dragPlane,p)?p:null}
function hit(e){const r=renderer.domElement.getBoundingClientRect();mouse.x=((e.clientX-r.left)/r.width)*2-1;mouse.y=-((e.clientY-r.top)/r.height)*2+1;raycaster.setFromCamera(mouse,camera3d);for(const h of raycaster.intersectObjects([cameraRoot,markRoot],true)){let o=h.object;while(o&&!o.userData?.kind)o=o.parent;if(o?.userData?.kind)return o.userData}return null}
renderer.domElement.addEventListener('pointerdown',e=>{if(!currentScene?.plan)return;const p=planePoint(e);if(!p)return;if(mode==='add-camera'){addCamera(p.x,p.z);setMode('select');return}if(mode==='add-mark'){addMark(p.x,p.z);setMode('select');return}const h=hit(e);if(!h){selected={kind:null,id:null};showProperties();return}selected={kind:h.kind,id:h.id};showProperties();const obj=h.kind==='camera'?currentScene.cameras.find(x=>x.id===h.id):currentScene.marks.find(x=>x.id===h.id);if(h.kind==='camera'&&obj?.fixed)return;drag=h;controls.enabled=false});
renderer.domElement.addEventListener('pointermove',e=>{if(!drag||!currentScene)return;const p=planePoint(e);if(!p)return;const a=drag.kind==='camera'?currentScene.cameras:currentScene.marks,o=a.find(x=>x.id===drag.id);if(o){o.x=p.x;o.z=p.z;renderObjects()}});
renderer.domElement.addEventListener('pointerup',()=>{if(drag){drag=null;controls.enabled=true;saveProject(false)}});

function newProject(data){return{id:uid('project'),name:data.name,siteType:data.siteType,address:data.address||'',note:data.note||'',createdAt:now(),updatedAt:now(),version:APP_VERSION,scenes:[]}}
function newScene(type,name){return{id:uid('scene'),type,name:name||type,plan:null,cameras:[],marks:[],obstacles:[]}}
async function saveProject(show=true){if(!currentProject)return;currentProject.name=$('projectNameInput').value.trim()||currentProject.name;currentProject.updatedAt=now();currentProject.version=APP_VERSION;await dbPut(clone(currentProject));$('editorProjectName').textContent=currentProject.name;$('saveInfo').textContent=`本機已儲存 ${new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`;if(show){try{if(APP_CONFIG.cloudApi?.enabled){await saveProjectCloud(currentProject);await dbPut(clone(currentProject))}toast('專案已儲存')}catch(err){setCloudStatus(false,'雲端儲存失敗');alert(`本機已儲存，但 Google Drive 同步失敗：${err.message}`)}}}
async function renderProjectCards(){const list=await dbAll(),el=$('projectCards');if(!list.length){el.innerHTML='<div class="empty-card">尚無專案。先按「建立新專案」，再建立樓層與匯入圖面。</div>';return}el.innerHTML=list.map(p=>{const n=(p.scenes||[]).reduce((s,x)=>s+(x.cameras?.length||0),0);return `<article class="project-card"><div><h3>${esc(p.name)}</h3><div class="meta">${esc(p.siteType||'')}<br>${p.scenes?.length||0} 個樓層・${n} 支鏡頭</div></div><div class="card-footer"><span class="meta">${new Date(p.updatedAt).toLocaleString()}</span><button data-open="${esc(p.id)}">開啟專案</button></div></article>`}).join('');el.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>openProject(b.dataset.open))}
async function openProject(id){const p=await dbGet(id);if(!p)return;currentProject=p;currentScene=p.scenes?.[0]||null;selected={kind:null,id:null};$('projectHome').classList.add('hidden');$('editorApp').classList.remove('hidden');$('projectNameInput').value=p.name;applyPanels();refreshEditor()}
async function goHome(){if(currentProject)await saveProject(false);currentProject=null;currentScene=null;$('editorApp').classList.add('hidden');$('projectHome').classList.remove('hidden');renderProjectCards()}
function renderSceneTree(){const el=$('sceneTree');if(!currentProject?.scenes?.length){el.innerHTML='<div class="empty-card" style="padding:18px">尚未建立樓層</div>';return}el.innerHTML=currentProject.scenes.map(s=>`<div class="scene-item ${currentScene?.id===s.id?'active':''}" data-id="${s.id}"><div class="scene-icon">${esc(s.type)}</div><div class="scene-text"><strong>${esc(s.name)}</strong><small>${s.plan?esc(s.plan.fileName):'尚未匯入圖面'}</small></div><span class="dot ${s.plan?'ready':''}"></span></div>`).join('');el.querySelectorAll('.scene-item').forEach(x=>x.onclick=()=>{currentScene=currentProject.scenes.find(s=>s.id===x.dataset.id);selected={kind:null,id:null};refreshEditor()})}
function refreshCounts(){if(!currentProject)return;const tc=currentProject.scenes.reduce((n,s)=>n+(s.cameras?.length||0),0),tm=currentProject.scenes.reduce((n,s)=>n+(s.marks?.length||0),0);$('sceneCount').textContent=currentProject.scenes.length;$('projectCameraCount').textContent=tc;$('projectMarkCount').textContent=tm;$('sceneCameraCount').textContent=currentScene?.cameras?.length||0;$('sceneMarkCount').textContent=currentScene?.marks?.length||0;$('sceneObstacleCount').textContent=currentScene?.obstacles?.length||0;$('cameraInfo').textContent=`鏡頭：${currentScene?.cameras?.length||0}`;$('planInfo').textContent=`圖面：${currentScene?.plan?.fileName||'—'}`}
function refreshEditor(){if(!currentProject)return;$('editorProjectName').textContent=currentProject.name;$('editorSceneName').textContent=currentScene?.name||'尚未建立樓層';$('floorBadge').textContent=currentScene?.type||'—';$('emptyScene').classList.toggle('hidden',!!currentScene);$('emptyPlan').classList.toggle('hidden',!currentScene||!!currentScene.plan);renderSceneTree();refreshCounts();buildScene();showProperties();renderTools('project');if(currentScene){$('sceneNameInput').value=currentScene.name;$('sceneTypeInput').value=FLOORS.includes(currentScene.type)?currentScene.type:'自訂';$('planOpacityInput').value=currentScene.plan?.opacity??1;$('planOpacityOut').textContent=`${Math.round((currentScene.plan?.opacity??1)*100)}%`;$('planRotationInput').value=String(currentScene.plan?.rotation||0)}}
function showProperties(){$('sceneProperties').classList.add('hidden');$('cameraProperties').classList.add('hidden');$('markProperties').classList.add('hidden');if(selected.kind==='camera'){const c=currentScene?.cameras.find(x=>x.id===selected.id);if(!c)return;$('propertyTitle').textContent='監視器屬性';$('cameraProperties').classList.remove('hidden');$('camName').value=c.name;$('camStatus').value=c.status;$('camLens').value=c.lens;$('camYaw').value=c.yaw;$('camYawOut').textContent=`${c.yaw}°`;$('camRange').value=c.range;$('camRangeOut').textContent=`${c.range}m`;$('camHeight').value=c.height;$('camFixed').checked=!!c.fixed;$('camShowFov').checked=c.showFov!==false;$('camNote').value=c.note||''}else if(selected.kind==='mark'){const m=currentScene?.marks.find(x=>x.id===selected.id);if(!m)return;$('propertyTitle').textContent='標記屬性';$('markProperties').classList.remove('hidden');$('markTitle').value=m.title;$('markType').value=m.type;$('markText').value=m.text||'';$('markPublic').checked=m.public!==false}else{$('propertyTitle').textContent='場景屬性';$('sceneProperties').classList.remove('hidden')}}
function addCamera(x,z){const n=currentScene.cameras.length+1,c={id:uid('cam'),name:`CAM-${currentScene.type}-${String(n).padStart(2,'0')}`,x,z,yaw:0,height:2.8,lens:'2.8',range:14,status:'existing',fixed:false,showFov:true,note:''};currentScene.cameras.push(c);selected={kind:'camera',id:c.id};renderObjects();showProperties();saveProject(false)}
function addMark(x,z){const n=currentScene.marks.length+1,m={id:uid('mark'),title:`標記-${String(n).padStart(2,'0')}`,type:'note',text:'',public:true,x,z};currentScene.marks.push(m);selected={kind:'mark',id:m.id};renderObjects();showProperties();saveProject(false)}
function setMode(m){mode=m;const text=m==='add-camera'?'請在平面圖上點選「監視器安裝位置」':m==='add-mark'?'請在平面圖上點選「標記位置」':'';$('modeHint').textContent=text;$('modeHint').classList.toggle('hidden',!text)}

function syncCam(){const c=currentScene?.cameras.find(x=>x.id===selected.id);if(!c)return;c.name=$('camName').value||c.name;c.status=$('camStatus').value;c.lens=$('camLens').value;c.yaw=+$('camYaw').value;c.range=+$('camRange').value;c.height=+$('camHeight').value||2.8;c.fixed=$('camFixed').checked;c.showFov=$('camShowFov').checked;c.note=$('camNote').value;$('camYawOut').textContent=`${c.yaw}°`;$('camRangeOut').textContent=`${c.range}m`;renderObjects()}
['camName','camStatus','camLens','camYaw','camRange','camHeight','camFixed','camShowFov','camNote'].forEach(id=>{$(id).addEventListener('input',syncCam);$(id).addEventListener('change',syncCam)});
function syncMark(){const m=currentScene?.marks.find(x=>x.id===selected.id);if(!m)return;m.title=$('markTitle').value||m.title;m.type=$('markType').value;m.text=$('markText').value;m.public=$('markPublic').checked}
['markTitle','markType','markText','markPublic'].forEach(id=>{$(id).addEventListener('input',syncMark);$(id).addEventListener('change',syncMark)});

async function imageToData(file){return new Promise((resolve,reject)=>{const fr=new FileReader();fr.onload=()=>{const img=new Image();img.onload=()=>{const max=2200,s=Math.min(1,max/img.width),c=document.createElement('canvas');c.width=Math.round(img.width*s);c.height=Math.round(img.height*s);c.getContext('2d').drawImage(img,0,0,c.width,c.height);resolve({dataUrl:c.toDataURL('image/jpeg',.9),width:c.width,height:c.height})};img.onerror=reject;img.src=fr.result};fr.onerror=reject;fr.readAsDataURL(file)})}
async function pdfToData(file){const pdfjs=await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs');pdfjs.GlobalWorkerOptions.workerSrc='https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';const pdf=await pdfjs.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise,p=await pdf.getPage(1),v0=p.getViewport({scale:1}),s=Math.min(2,2200/v0.width),v=p.getViewport({scale:s}),c=document.createElement('canvas');c.width=Math.round(v.width);c.height=Math.round(v.height);await p.render({canvasContext:c.getContext('2d'),viewport:v}).promise;return{dataUrl:c.toDataURL('image/jpeg',.9),width:c.width,height:c.height}}
function parseDxf(text){const l=text.replace(/\r/g,'').split('\n'),pairs=[];for(let i=0;i+1<l.length;i+=2)pairs.push([+l[i].trim(),l[i+1].trim()]);const seg=[];for(let i=0;i<pairs.length;){const [c,v]=pairs[i];if(c===0&&v==='LINE'){let x1=0,y1=0,x2=0,y2=0;i++;while(i<pairs.length&&pairs[i][0]!==0){const [k,z]=pairs[i];if(k===10)x1=+z;else if(k===20)y1=+z;else if(k===11)x2=+z;else if(k===21)y2=+z;i++}seg.push([x1,y1,x2,y2]);continue}i++}return seg}
async function dxfToData(file){const s=parseDxf(await file.text());if(!s.length)throw new Error('DXF 未找到 LINE 線段，請先輸出成 PDF。');const xs=[],ys=[];s.forEach(a=>{xs.push(a[0],a[2]);ys.push(a[1],a[3])});const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys),sx=Math.max(1,maxX-minX),sy=Math.max(1,maxY-minY),W=1800,H=Math.max(900,Math.round(W*sy/sx)),pad=50,scale=Math.min((W-pad*2)/sx,(H-pad*2)/sy),c=document.createElement('canvas'),ctx=c.getContext('2d');c.width=W;c.height=H;ctx.fillStyle='#f7f7f3';ctx.fillRect(0,0,W,H);ctx.strokeStyle='#222';ctx.beginPath();s.forEach(([x1,y1,x2,y2])=>{ctx.moveTo(pad+(x1-minX)*scale,H-pad-(y1-minY)*scale);ctx.lineTo(pad+(x2-minX)*scale,H-pad-(y2-minY)*scale)});ctx.stroke();return{dataUrl:c.toDataURL('image/png'),width:W,height:H}}
async function importPlan(file){if(!currentScene)return;if(/\.dwg$/i.test(file.name)){alert('DWG 目前請先轉成 DXF 或 PDF。');return}let r;if(file.type.startsWith('image/'))r=await imageToData(file);else if(file.type==='application/pdf'||/\.pdf$/i.test(file.name))r=await pdfToData(file);else if(/\.dxf$/i.test(file.name))r=await dxfToData(file);else throw new Error('不支援此格式');currentScene.plan={fileName:file.name,dataUrl:r.dataUrl,width:r.width,height:r.height,opacity:1,rotation:0};await saveProject(false);refreshEditor();toast('圖面已匯入')}
$('planFileInput').onchange=async e=>{const f=e.target.files?.[0];if(!f)return;try{await importPlan(f)}catch(err){alert(err.message)}e.target.value=''};$('choosePlanBtn').onclick=()=>$('planFileInput').click();$('replacePlanBtn').onclick=()=>$('planFileInput').click();$('removePlanBtn').onclick=async()=>{if(!currentScene?.plan)return;if(confirm('移除此樓層圖面？')){currentScene.plan=null;await saveProject(false);refreshEditor()}};const dz=$('dropZone');['dragenter','dragover'].forEach(t=>dz.addEventListener(t,e=>{e.preventDefault();dz.classList.add('dragover')}));['dragleave','drop'].forEach(t=>dz.addEventListener(t,e=>{e.preventDefault();dz.classList.remove('dragover')}));dz.addEventListener('drop',e=>{const f=e.dataTransfer.files?.[0];if(f)importPlan(f)});

function renderTools(menu){const data={project:[['儲存專案','save'],['匯出專案','export'],['新增樓層','new-scene']],plan:[['匯入 / 更換圖面','plan'],['透明度 100%','op1'],['透明度 50%','op5']],environment:[['＋ 牆體（下一階段）','todo'],['＋ 柱子（下一階段）','todo'],['＋ 車輛（下一階段）','todo']],camera:[['＋ 新增監視器','add-camera'],['顯示全部視野','show'],['隱藏全部視野','hide']],mark:[['＋ 新增標記','add-mark']],measure:[['兩點實尺校正（下一階段）','todo']],view:[['3D','3d'],['俯視','top'],['重設視角','reset'],['專注模式','focus']],report:[['輸出鏡頭配置報告（下一階段）','todo']]};$('toolShelf').innerHTML=`<span class="tool-label">${menu.toUpperCase()}</span>`+(data[menu]||[]).map(([x,a])=>`<button data-act="${a}">${x}</button>`).join('');$('toolShelf').querySelectorAll('[data-act]').forEach(b=>b.onclick=()=>runTool(b.dataset.act))}
function runTool(a){if(a==='save')return saveProject();if(a==='export')return exportProject();if(a==='new-scene')return openSceneModal();if(a==='plan')return $('planFileInput').click();if(a==='op1'&&currentScene?.plan){currentScene.plan.opacity=1;buildFloor()}else if(a==='op5'&&currentScene?.plan){currentScene.plan.opacity=.5;buildFloor()}else if(a==='add-camera')setMode('add-camera');else if(a==='add-mark')setMode('add-mark');else if(a==='show'){currentScene.cameras.forEach(c=>c.showFov=true);renderObjects()}else if(a==='hide'){currentScene.cameras.forEach(c=>c.showFov=false);renderObjects()}else if(a==='3d')resetView();else if(a==='top')topView();else if(a==='reset')resetView();else if(a==='focus')toggleFocus();else toast('此功能排在下一階段加入')}
document.querySelectorAll('.main-menu button').forEach(b=>b.onclick=()=>renderTools(b.dataset.menu));

function applyPanels(){const g=$('editorGrid');g.classList.toggle('left-collapsed',!!uiState.leftCollapsed);g.classList.toggle('right-collapsed',!!uiState.rightCollapsed);$('expandLeftBtn').classList.toggle('hidden',!uiState.leftCollapsed);$('expandRightBtn').classList.toggle('hidden',!uiState.rightCollapsed);requestAnimationFrame(resize)}
$('collapseLeftBtn').onclick=()=>{uiState.leftCollapsed=true;saveUIState();applyPanels()};$('expandLeftBtn').onclick=()=>{uiState.leftCollapsed=false;saveUIState();applyPanels()};$('collapseRightBtn').onclick=()=>{uiState.rightCollapsed=true;saveUIState();applyPanels()};$('expandRightBtn').onclick=()=>{uiState.rightCollapsed=false;saveUIState();applyPanels()};function toggleFocus(){document.body.classList.toggle('focus-mode');requestAnimationFrame(resize)}$('focusModeBtn').onclick=toggleFocus;
function showModal(id){$(id).classList.remove('hidden')}function hideModal(id){$(id).classList.add('hidden')}document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>hideModal(b.dataset.close));
$('newProjectBtn').onclick=()=>showModal('newProjectModal');$('createProjectConfirmBtn').onclick=async()=>{const name=$('newProjectName').value.trim();if(!name)return alert('請輸入專案名稱');const p=newProject({name,siteType:$('newProjectType').value,address:$('newProjectAddress').value.trim(),note:$('newProjectNote').value.trim()});await dbPut(p);hideModal('newProjectModal');openProject(p.id)};
function openSceneModal(){if(!currentProject)return;$('newSceneType').value='B1';$('newSceneName').value='B1 地下停車場';showModal('newSceneModal')}$('addSceneBtn').onclick=openSceneModal;$('emptyAddSceneBtn').onclick=openSceneModal;$('newSceneType').onchange=()=>{const t=$('newSceneType').value;$('newSceneName').value=t==='自訂'?'':`${t} ${t.startsWith('B')?'地下停車場':'場景'}`};$('createSceneConfirmBtn').onclick=async()=>{const t=$('newSceneType').value,n=$('newSceneName').value.trim()||t,s=newScene(t,n);currentProject.scenes.push(s);currentScene=s;hideModal('newSceneModal');await saveProject(false);refreshEditor()};
$('backHomeBtn').onclick=goHome;$('saveProjectBtn').onclick=()=>saveProject();$('projectNameInput').onchange=()=>saveProject(false);$('sceneNameInput').onchange=async()=>{if(currentScene){currentScene.name=$('sceneNameInput').value.trim()||currentScene.name;await saveProject(false);refreshEditor()}};$('sceneTypeInput').onchange=async()=>{if(currentScene){currentScene.type=$('sceneTypeInput').value;await saveProject(false);refreshEditor()}};$('planOpacityInput').oninput=()=>{if(currentScene?.plan){currentScene.plan.opacity=+$('planOpacityInput').value;$('planOpacityOut').textContent=`${Math.round(currentScene.plan.opacity*100)}%`;if(floorPlane)floorPlane.material.opacity=currentScene.plan.opacity}};$('planRotationInput').onchange=async()=>{if(currentScene?.plan){currentScene.plan.rotation=+$('planRotationInput').value;await saveProject(false);buildFloor()}};
$('deleteCameraBtn').onclick=async()=>{const c=currentScene?.cameras.find(x=>x.id===selected.id);if(c&&confirm(`刪除鏡頭「${c.name}」？`)){currentScene.cameras=currentScene.cameras.filter(x=>x.id!==c.id);selected={kind:null,id:null};await saveProject(false);renderObjects();showProperties()}};$('deleteMarkBtn').onclick=async()=>{const m=currentScene?.marks.find(x=>x.id===selected.id);if(m&&confirm(`刪除標記「${m.title}」？`)){currentScene.marks=currentScene.marks.filter(x=>x.id!==m.id);selected={kind:null,id:null};await saveProject(false);renderObjects();showProperties()}};
$('zoomInBtn').onclick=()=>zoom(.82);$('zoomOutBtn').onclick=()=>zoom(1.22);$('resetViewBtn').onclick=resetView;$('topViewBtn').onclick=topView;$('view3dBtn').onclick=resetView;$('fullscreenBtn').onclick=()=>!document.fullscreenElement?viewer.requestFullscreen?.():document.exitFullscreen?.();
async function exportProject(){if(!currentProject)return;await saveProject(false);const blob=new Blob([JSON.stringify({format:'UTOP-CCTV3D',formatVersion:2,appVersion:APP_VERSION,project:clone(currentProject)},null,2)],{type:'application/json'}),u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download=`${currentProject.name.replace(/[\\/:*?"<>|]+/g,'-')}-${APP_VERSION}.cctv3d`;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)}$('exportProjectBtn').onclick=exportProject;
$('importProjectBtn').onclick=()=>$('importProjectFile').click();$('importProjectFile').onchange=async e=>{const f=e.target.files?.[0];if(!f)return;try{const x=JSON.parse(await f.text()),p=x.project||x;if(!p?.name)throw new Error('格式不正確');p.id=uid('project');p.updatedAt=now();p.version=APP_VERSION;await dbPut(p);renderProjectCards();toast('專案已匯入')}catch(err){alert(`匯入失敗：${err.message}`)}e.target.value=''};$('deleteProjectBtn').onclick=async()=>{if(currentProject&&confirm(`確定刪除專案「${currentProject.name}」？`)){await dbDelete(currentProject.id);goHome()}};$('refreshProjectListBtn').onclick=renderProjectCards;if($('refreshCloudProjectsBtn'))$('refreshCloudProjectsBtn').onclick=()=>{activeApiUrl='';renderCloudProjectCards()};


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
