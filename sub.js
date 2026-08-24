/* =========================================================
   PURIKURA BOOTH - sub.js
   サブ画面：メイン画面(index.html)と同じブラウザ内で
   BroadcastChannelを使って同期する。
   - メイン画面が撮影中 → カメラのプレビュー＋広告バーを表示
   - それ以外（待機中・編集中など） → 広告スライドショーを表示
   ========================================================= */

const cameraView = document.getElementById('sub-camera-view');
const cameraImg = document.getElementById('sub-camera-img');
const cameraCaption = document.getElementById('sub-camera-caption');
const adLayer = document.getElementById('sub-ad-layer');
const adBar = document.getElementById('sub-ad-bar');
const offlineNotice = document.getElementById('sub-offline-notice');

let slideshowController = null;
let barController = null;
let lastMessageAt = 0;

function getMainSettings(){
  try{ return JSON.parse(localStorage.getItem('purikuraSettings') || '{}'); }
  catch(e){ return {}; }
}

function applyCaption(){
  const text = (getMainSettings().subCameraCaption || '').trim();
  if(text){
    cameraCaption.textContent = text;
    cameraCaption.style.display = 'block';
  }else{
    cameraCaption.style.display = 'none';
  }
}

function ensureBarRunning(){
  if(!barController){
    barController = window.PurikuraAds.mount(adBar, 'bar');
  }
}

function showCameraView(dataURL){
  if(slideshowController){ slideshowController.stop(); slideshowController = null; }
  adLayer.style.display = 'none';
  offlineNotice.style.display = 'none';
  cameraView.style.display = 'flex';
  cameraImg.src = dataURL;
  ensureBarRunning();
}
function showAdView(){
  cameraView.style.display = 'none';
  offlineNotice.style.display = 'none';
  adLayer.style.display = 'block';
  if(!slideshowController){
    slideshowController = window.PurikuraAds.mount(adLayer, 'slideshow');
  }
  ensureBarRunning(); // 広告バーは待機中もそのまま表示し続ける
}

let channel = null;
try{
  channel = new BroadcastChannel('purikura-sync');
  channel.onmessage = (e)=>{
    const msg = e.data;
    if(!msg) return;
    lastMessageAt = Date.now();
    if(msg.type === 'camera-frame'){
      showCameraView(msg.dataURL);
    }else if(msg.type === 'status'){
      if(msg.screen !== 'camera'){
        showAdView();
      }
    }
  };
}catch(e){
  console.warn('BroadcastChannelが使えない環境です', e);
}

applyCaption();
// メイン画面からのメッセージを一度も受信できていない場合、案内を出す（広告は表示したまま）
showAdView();
setTimeout(()=>{
  if(lastMessageAt === 0){
    offlineNotice.style.display = 'block';
  }
}, 6000);
if(channel){
  const clearNoticeOnFirstMessage = ()=>{
    offlineNotice.style.display = 'none';
  };
  channel.addEventListener('message', clearNoticeOnFirstMessage, { once: true });
}
