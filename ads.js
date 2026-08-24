/* =========================================================
   PURIKURA BOOTH - ads.js
   サブ画面で共通して使う「広告スライドショー」
   自分で登録した画像/動画 と、Google AdSense（設定時）を
   順番に表示する。設定は localStorage の purikuraSettings を
   直接読む（同じオリジンのタブ・ウィンドウ間で共有される）。

   2種類の枠に対応：
   - 'slideshow' : メイン表示エリア用（画像/動画 + AdSense）
   - 'bar'       : 横長の広告バー用（画像/動画のみ、AdSenseは混ぜない）
   ========================================================= */
window.PurikuraAds = (function(){
  let adsenseScriptRequested = false;

  const KIND_CONFIG = {
    slideshow: { itemsKey: 'adItems', intervalKey: 'adIntervalSec', allowAdsense: true },
    bar:       { itemsKey: 'adBarItems', intervalKey: 'adBarIntervalSec', allowAdsense: false },
  };

  function loadAdConfig(kind){
    const map = KIND_CONFIG[kind] || KIND_CONFIG.slideshow;
    try{
      const raw = localStorage.getItem('purikuraSettings');
      if(!raw) return { items: [], intervalSec: 8, adsensePub: '', adsenseSlot: '' };
      const s = JSON.parse(raw);
      let items = Array.isArray(s[map.itemsKey]) ? s[map.itemsKey] : [];
      // 広告バー専用の素材が未登録なら、画面いっぱいのスライドショー用の素材を代わりに使う
      if(kind === 'bar' && items.length === 0 && Array.isArray(s.adItems)){
        items = s.adItems;
      }
      return {
        items,
        intervalSec: s[map.intervalKey] || 8,
        adsensePub: map.allowAdsense ? (s.adsensePub || '') : '',
        adsenseSlot: map.allowAdsense ? (s.adsenseSlot || '') : '',
      };
    }catch(e){
      return { items: [], intervalSec: 8, adsensePub: '', adsenseSlot: '' };
    }
  }

  function ensureAdsenseScript(pub){
    if(adsenseScriptRequested || !pub) return;
    adsenseScriptRequested = true;
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' + encodeURIComponent(pub);
    s.crossOrigin = 'anonymous';
    document.head.appendChild(s);
  }

  function renderAdsense(container, pub, slot){
    const ins = document.createElement('ins');
    ins.className = 'adsbygoogle idle-ad-media';
    ins.style.display = 'block';
    ins.setAttribute('data-ad-client', pub);
    ins.setAttribute('data-ad-slot', slot);
    ins.setAttribute('data-ad-format', 'auto');
    ins.setAttribute('data-full-width-responsive', 'true');
    container.appendChild(ins);
    ensureAdsenseScript(pub);
    try{ (window.adsbygoogle = window.adsbygoogle || []).push({}); }catch(e){ /* AdSense未承認サイト等では失敗することがある */ }
  }

  // container に広告スライドショーを表示し続ける。stop()で止められる。
  // kind: 'slideshow'（既定） or 'bar'
  function mount(container, kind){
    kind = kind || 'slideshow';
    let index = 0;
    let timer = null;
    let stopped = false;

    function renderCurrent(){
      if(stopped) return;
      const cfg = loadAdConfig(kind);
      const rotation = cfg.items.slice();
      if(cfg.adsensePub && cfg.adsenseSlot) rotation.push({ type: 'adsense' });

      container.innerHTML = '';
      if(rotation.length === 0){
        if(kind === 'slideshow'){
          const placeholder = document.createElement('div');
          placeholder.className = 'idle-ad-placeholder';
          placeholder.textContent = '📸 PURIKURA BOOTH 📸';
          container.appendChild(placeholder);
        }
        // バーは何も登録されていなければ空のまま（プレースホルダーは表示しない）
      }else{
        const item = rotation[index % rotation.length];
        if(item.type === 'adsense'){
          renderAdsense(container, cfg.adsensePub, cfg.adsenseSlot);
        }else if(item.type && item.type.indexOf('video') === 0){
          const v = document.createElement('video');
          v.src = item.src; v.autoplay = true; v.muted = true; v.loop = true; v.playsInline = true;
          v.className = 'idle-ad-media';
          container.appendChild(v);
        }else{
          const img = document.createElement('img');
          img.src = item.src;
          img.className = 'idle-ad-media';
          container.appendChild(img);
        }
        index++;
      }
      clearTimeout(timer);
      timer = setTimeout(renderCurrent, Math.max(3, cfg.intervalSec || 8) * 1000);
    }

    renderCurrent();
    return {
      stop(){ stopped = true; clearTimeout(timer); },
    };
  }

  return { mount, loadAdConfig };
})();
