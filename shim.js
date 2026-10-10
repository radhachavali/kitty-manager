/* ===== Kitty Manager website adapter =====
   Lets the same app that runs inside Claude run as a normal website on Firebase.
   It supplies window.claude (user, db, downloads) before the app starts.
   - Sign-in: Google.
   - The admin (treasurer) is the account named in firebase-config.js (owner).
   - Everyone else sees only the chits whose join code they typed (access/{uid}).
   Every saved document carries a field _g (its group: a chit id, or "_u_<uid>" for the person's own notes). */
(function(){
  var CFG=window.KM_CONFIG||{},FB=CFG.firebase||{};
  var OWNER=String(CFG.owner||'').toLowerCase();
  var gate=null,me=null,isOwner=false,fs=null,auth=null,readyRes,ready=new Promise(function(r){readyRes=r;});
  var K={chits:{},parties:{}};            // groups this page knows about
  var accessG=[],accessWait=[],accessLoaded=false,accessUnsub=null;

  function el(h){var d=document.createElement('div');d.innerHTML=h;return d.firstChild;}
  function showGate(msg,busy){
    if(!gate){
      gate=el('<div id="kmgate" style="position:fixed;inset:0;z-index:100;background:#fbf6f1;color:#2a1f2d;display:flex;align-items:center;justify-content:center;padding:24px;font:18px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif"><div style="max-width:420px;width:100%;text-align:center"><div style="font-size:54px">💰</div><h1 style="font-size:32px;margin:6px 0">Kitty Manager</h1><p style="color:#6f6270;margin:0 0 22px">Fair, clear and shared. Sign in to open your chit.</p><button id="kmsign" style="width:100%;min-height:58px;border-radius:16px;border:0;background:#7a2e6e;color:#fff;font:800 20px system-ui;cursor:pointer">Sign in with Google</button><p id="kmmsg" style="color:#b3261e;font-weight:700;min-height:24px;margin-top:14px"></p></div></div>');
      document.body.appendChild(gate);
      gate.querySelector('#kmsign').onclick=function(){signIn();};
    }
    gate.style.display='flex';
    var m=gate.querySelector('#kmmsg');if(m)m.textContent=msg||'';
    var b=gate.querySelector('#kmsign');if(b){b.disabled=!!busy;b.textContent=busy?'Please wait…':'Sign in with Google';}
  }
  function hideGate(){if(gate)gate.style.display='none';}
  function signIn(){
    showGate('',true);
    var p=new firebase.auth.GoogleAuthProvider();
    auth.signInWithPopup(p).catch(function(e){
      var c=(e&&e.code)||'';
      if(c==='auth/popup-blocked'||c==='auth/operation-not-supported-in-this-environment'){return auth.signInWithRedirect(p);}
      if(c==='auth/popup-closed-by-user'||c==='auth/cancelled-popup-request'){showGate('Sign-in was closed. Tap the button to try again.');return;}
      if(c==='auth/unauthorized-domain'){showGate('This website address is not allowed yet. The admin must add it in Firebase, Authentication, Settings, Authorized domains.');return;}
      showGate('Could not sign in. '+String((e&&e.message)||c).slice(0,140));
    });
  }
  function signOutBtn(){
    if(document.getElementById('kmout'))return;
    var b=el('<button id="kmout" style="position:fixed;left:10px;bottom:10px;z-index:30;border:1px solid #eadfd6;background:#fffdfb;color:#6f6270;border-radius:999px;padding:6px 12px;font:700 13px system-ui;cursor:pointer;opacity:.85">Sign out</button>');
    b.onclick=function(){try{localStorage.removeItem('cq');}catch(e){}auth.signOut().then(function(){location.reload();});};
    document.body.appendChild(b);
  }

  /* ---- which group does a document belong to? ---- */
  function known(g){return g&&(K.chits[g]||Object.prototype.hasOwnProperty.call(K.parties,g));}
  function top(g){return K.chits[g]?g:(K.parties[g]||g);}
  function groupOf(col,id,data){
    data=data||{};
    if(col==='chits')return id;
    if(col==='parties')return data.cid||id;
    var c=[data.cid,data.gid,data.pid],p=String(id).split('_');
    c.push(p[0]);if(col==='skdata'&&p.length>1)c.push(p[1]);
    for(var i=0;i<c.length;i++){if(known(c[i]))return top(c[i]);}
    return '_u_'+me.uid;
  }
  function noteDocs(col,docs){
    if(col==='chits')docs.forEach(function(d){K.chits[d.id]=1;});
    if(col==='parties')docs.forEach(function(d){var v=d.data();K.parties[d.id]=(v&&v.cid)||null;});
  }
  function strip(o){var r={};Object.keys(o||{}).forEach(function(k){if(k!=='_g')r[k]=o[k];});return r;}
  function wrap(d){return {id:d.id,data:function(){return strip(d.data());}};}
  var lastChits={};

  /* ---- codes index: the admin publishes each join code so a member can find her chit ---- */
  function syncCodes(id,data){
    var old=lastChits[id]&&lastChits[id].inv||{},nu=(data&&data.inv)||{},seen={};
    Object.keys(nu).forEach(function(mid){var code=nu[mid];seen[code]=1;fs.collection('codes').doc(code).set({cid:id,mid:mid}).catch(function(){});});
    Object.keys(old).forEach(function(mid){var code=old[mid];if(!seen[code])fs.collection('codes').doc(code).delete().catch(function(){});});
  }

  /* ---- the db the app sees ---- */
  function collection(col){
    return {
      doc:function(id){
        var ref=fs.collection(col).doc(id);
        return {
          set:function(data){
            if(col==='chits'){K.chits[id]=1;if(isOwner)syncCodes(id,data);lastChits[id]=data;}
            if(col==='parties')K.parties[id]=data.cid||null;
            var g=groupOf(col,id,data),d=JSON.parse(JSON.stringify(data));d._g=g;
            return ref.set(d);
          },
          delete:function(){if(col==='chits'&&isOwner){syncCodes(id,null);delete lastChits[id];}return ref.delete();},
          get:function(){return ref.get().then(function(r){return {exists:r.exists,id:r.id,data:function(){return strip(r.data());}};});}
        };
      },
      onSnapshot:function(cb,errcb){return listen(col,cb,errcb);}
    };
  }
  function listen(col,cb,errcb){
    if(isOwner){
      return fs.collection(col).onSnapshot(function(s){noteDocs(col,s.docs);if(col==='chits')s.docs.forEach(function(d){lastChits[d.id]=d.data();});cb({docs:s.docs.map(wrap)});},errcb);
    }
    /* a member: one listener per group she may read, merged into one list */
    var subs={},bag={},dead=false,first=false;
    function emit(){var all=[];Object.keys(bag).forEach(function(g){all=all.concat(bag[g]);});noteDocs(col,all);cb({docs:all.map(wrap)});}
    function sync(){
      if(dead)return;
      var want=accessG.concat(['_u_'+me.uid]);
      want.forEach(function(g){
        if(subs[g])return;
        subs[g]=fs.collection(col).where('_g','==',g).onSnapshot(function(s){bag[g]=s.docs;emit();},function(e){if(errcb&&!(e&&e.code==='permission-denied'&&g!=='_u_'+me.uid))errcb(e);});
      });
      Object.keys(subs).forEach(function(g){if(want.indexOf(g)<0){subs[g]();delete subs[g];delete bag[g];emit();}});
      if(!first){first=true;emit();}
    }
    accessWait.push(sync);if(accessLoaded)sync();
    return function(){dead=true;Object.keys(subs).forEach(function(g){subs[g]();});};
  }
  function watchAccess(){
    accessUnsub=fs.collection('access').doc(me.uid).onSnapshot(function(s){
      accessG=(s.exists&&s.data().g)||[];accessLoaded=true;accessWait.forEach(function(f){f();});
    },function(){accessG=[];accessLoaded=true;accessWait.forEach(function(f){f();});});
  }

  /* ---- joining with a code ---- */
  function sleep(ms){return new Promise(function(r){setTimeout(r,ms);});}
  async function redeem(code){
    code=String(code||'').normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g,'');
    if(code.length!==6)return false;
    var cd;try{cd=await fs.collection('codes').doc(code).get();}catch(e){return false;}
    if(!cd.exists)return false;
    var cid=cd.data().cid;
    if(isOwner)return true;
    if(accessG.indexOf(cid)<0){
      try{await fs.collection('access').doc(me.uid).set({g:accessG.concat([cid]),code:code});}catch(e){return false;}
    }
    for(var i=0;i<50;i++){if(K.chits[cid])break;await sleep(200);}
    await sleep(350);
    return !!K.chits[cid];
  }
  window.__KMW={redeem:redeem,owner:function(){return isOwner;},uid:function(){return me&&me.uid;}};

  /* ---- what the app asks for ---- */
  function saveFile(o){
    var b=new Blob([o.data],{type:'text/plain;charset=utf-8'}),a=document.createElement('a');
    a.href=URL.createObjectURL(b);a.download=o.filename||'file.txt';document.body.appendChild(a);a.click();
    setTimeout(function(){URL.revokeObjectURL(a.href);a.remove();},500);return Promise.resolve();
  }
  window.claude={use:function(name){
    return ready.then(function(){
      if(name==='db')return {collection:collection};
      if(name==='user')return {isOwner:function(){return isOwner;},can:function(){return true;},id:function(){return me.uid;},me:function(){return {id:me.uid,name:me.displayName||''};}};
      if(name==='downloads')return {save:saveFile};
      return null;
    });
  }};

  /* ---- start ---- */
  function start(){
    if(!FB.apiKey||String(FB.apiKey).indexOf('PASTE')>-1){
      document.body.appendChild(el('<div style="padding:24px;font:18px system-ui">Kitty Manager is not connected to Firebase yet. Fill in firebase-config.js.</div>'));return;
    }
    firebase.initializeApp(FB);auth=firebase.auth();fs=firebase.firestore();
    showGate('',true);
    auth.onAuthStateChanged(function(u){
      if(!u){showGate('');return;}
      me=u;isOwner=!!OWNER&&String(u.email||'').toLowerCase()===OWNER&&u.emailVerified!==false;
      hideGate();signOutBtn();
      if(!isOwner)watchAccess();
      readyRes(true);
    });
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
})();
