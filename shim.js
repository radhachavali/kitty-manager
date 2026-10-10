/* ===== Kitty Manager website adapter =====
   Lets the same app that runs inside Claude run as a normal website on Firebase.
   It supplies window.claude (user, db, downloads) before the app starts.
   - Sign-in: Google (admin and anyone), and optionally phone number + SMS code (members only; set phone:true in firebase-config.js).
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
  var BTN='width:100%;min-height:58px;border-radius:16px;border:0;font:800 20px system-ui;cursor:pointer;';
  var INP='width:100%;box-sizing:border-box;min-height:56px;border-radius:14px;border:2px solid #eadfd6;background:#fff;color:#2a1f2d;font:700 22px system-ui;padding:0 14px;text-align:center;margin-bottom:12px';
  var confirmRes=null,rcv=null,phoneOn=!!CFG.phone;
  function gq(i){return gate.querySelector(i);}
  function showGate(msg,busy){
    if(!gate){
      gate=el('<div id="kmgate" style="position:fixed;inset:0;z-index:100;background:#fbf6f1;color:#2a1f2d;display:flex;align-items:center;justify-content:center;padding:24px;font:18px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif"><div style="max-width:420px;width:100%;text-align:center"><div style="font-size:54px">💰</div><h1 style="font-size:32px;margin:6px 0">Kitty Manager</h1><p style="color:#6f6270;margin:0 0 22px">Fair, clear and shared. Sign in to open your chit.</p>'
        +'<div id="kmmain"><button id="kmsign" style="'+BTN+'background:#7a2e6e;color:#fff">Sign in with Google</button>'
        +(phoneOn?'<button id="kmphone" style="'+BTN+'background:#fffdfb;color:#7a2e6e;border:2px solid #7a2e6e;margin-top:12px">Use my phone number</button>':'')+'</div>'
        +'<div id="kmph" style="display:none"><p style="margin:0 0 8px;font-weight:700">Your mobile number</p><input id="kmnum" type="tel" inputmode="tel" autocomplete="tel" placeholder="+91 98765 43210" style="'+INP+'"><button id="kmsend" style="'+BTN+'background:#7a2e6e;color:#fff">Send code</button><button id="kmback1" style="background:none;border:0;color:#6f6270;font:700 16px system-ui;margin-top:10px;cursor:pointer">Back</button></div>'
        +'<div id="kmcd" style="display:none"><p id="kmcdt" style="margin:0 0 8px;font-weight:700">Type the 6-digit code</p><input id="kmcode" type="tel" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="••••••" style="'+INP+';letter-spacing:8px"><button id="kmver" style="'+BTN+'background:#7a2e6e;color:#fff">Confirm</button><button id="kmback2" style="background:none;border:0;color:#6f6270;font:700 16px system-ui;margin-top:10px;cursor:pointer">Use a different number</button></div>'
        +'<div id="kmrc"></div><p id="kmmsg" style="color:#b3261e;font-weight:700;min-height:24px;margin-top:14px"></p></div></div>');
      document.body.appendChild(gate);
      gq('#kmsign').onclick=function(){signIn();};
      if(phoneOn){
        gq('#kmphone').onclick=function(){pane('ph');};
        gq('#kmback1').onclick=function(){pane('main');};
        gq('#kmback2').onclick=function(){pane('ph');};
        gq('#kmsend').onclick=sendCode;
        gq('#kmver').onclick=verifyCode;
      }
    }
    gate.style.display='flex';
    var m=gq('#kmmsg');if(m)m.textContent=msg||'';
    var b=gq('#kmsign');if(b){b.disabled=!!busy;b.textContent=busy?'Please wait…':'Sign in with Google';}
    ['#kmphone','#kmsend','#kmver'].forEach(function(i){var x=gq(i);if(x)x.disabled=!!busy;});
  }
  function pane(n){
    gq('#kmmain').style.display=n==='main'?'block':'none';
    gq('#kmph').style.display=n==='ph'?'block':'none';
    gq('#kmcd').style.display=n==='cd'?'block':'none';
    gq('#kmmsg').textContent='';
  }
  /* Phone number: accepts 10-digit Indian numbers or full +country numbers */
  function fixPhone(v){
    v=String(v||'').replace(/[\s\-().]/g,'');
    if(/^\+\d{8,15}$/.test(v))return v;
    if(/^00\d{8,15}$/.test(v))return '+'+v.slice(2);
    if(/^91\d{10}$/.test(v))return '+'+v;
    if(/^0?[6-9]\d{9}$/.test(v))return '+91'+v.replace(/^0/,'');
    return '';
  }
  function resetRc(){try{if(rcv){rcv.clear();}}catch(e){}rcv=null;var h=gq('#kmrc');if(h)h.innerHTML='';}
  function sendCode(){
    var num=fixPhone(gq('#kmnum').value);
    if(!num){showGate('Please type your 10-digit mobile number.');return;}
    showGate('',true);
    try{
      resetRc();
      var h=document.createElement('div');gq('#kmrc').appendChild(h);
      rcv=new firebase.auth.RecaptchaVerifier(h,{size:'invisible'});
      auth.signInWithPhoneNumber(num,rcv).then(function(c){
        confirmRes=c;showGate('');gq('#kmcdt').textContent='Type the 6-digit code sent to '+num;pane('cd');gq('#kmcode').value='';gq('#kmcode').focus();
      }).catch(function(e){resetRc();showGate(phoneErr(e));});
    }catch(e){resetRc();showGate(phoneErr(e));}
  }
  function verifyCode(){
    var c=String(gq('#kmcode').value||'').replace(/\D/g,'');
    if(c.length!==6){showGate('Please type the 6-digit code.');return;}
    if(!confirmRes){showGate('Please ask for a new code.');pane('ph');return;}
    showGate('',true);
    confirmRes.confirm(c).catch(function(e){showGate(phoneErr(e));});
  }
  function phoneErr(e){
    var c=(e&&e.code)||'';
    if(c==='auth/invalid-phone-number')return 'That number does not look right. Please check it.';
    if(c==='auth/invalid-verification-code')return 'That code is wrong. Please try again.';
    if(c==='auth/code-expired')return 'The code expired. Please ask for a new one.';
    if(c==='auth/too-many-requests')return 'Too many tries. Please wait a while and try again.';
    if(c==='auth/quota-exceeded')return 'Text messages are over the limit for today. Please try Google sign-in or try tomorrow.';
    if(c==='auth/operation-not-allowed')return 'Phone sign-in is not turned on yet. Please use Google sign-in.';
    if(c==='auth/unauthorized-domain')return 'This website address is not allowed yet. The admin must add it in Firebase, Authentication, Settings, Authorized domains.';
    if(c==='auth/captcha-check-failed'||c==='auth/internal-error')return 'Could not verify this browser. Please reload and try again.';
    return 'Could not sign in. '+String((e&&e.message)||c).slice(0,120);
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
