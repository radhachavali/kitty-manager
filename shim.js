/* ===== Kitty Manager website adapter =====
   Lets the same app that runs inside Claude run as a normal website on Firebase.
   It supplies window.claude (user, db, downloads) before the app starts.
   - Sign-in: Google (admin and anyone), and optionally phone number + SMS code (members only; set phone:true in firebase-config.js).
   - Every signed-in person can run chits: whoever creates a chit is its treasurer (the chit carries _o = her id).
   - A person also sees the chits whose join code she typed (access/{uid}). The account named in firebase-config.js is the app owner (admin): it claims old chits that have no _o.
   Every saved document carries a field _g (its group: a chit id, or "_u_<uid>" for the person's own notes). */
(function(){
  var CFG=window.KM_CONFIG||{},FB=CFG.firebase||{};
  var OWNER=String(CFG.owner||'').toLowerCase();
  var gate=null,me=null,isAdmin=false,fs=null,auth=null,readyRes,ready=new Promise(function(r){readyRes=r;});
  var K={chits:{},parties:{},own:{}};            // groups this page knows about
  var myReq=null,canMake=false,unlockedDoc=false,reqs=[],reqUnsub=null,accessG=[],accessWait=[],accessLoaded=false,accessUnsub=null,lastLoadErr='';

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
    if(col==='parties')return data.cid||K.parties[id]||('_u_'+me.uid);
    var c=[data.cid,data.gid,data.pid],p=String(id).split('_');
    c.push(p[0]);if(col==='skdata'&&p.length>1)c.push(p[1]);
    for(var i=0;i<c.length;i++){if(known(c[i]))return top(c[i]);}
    return '_u_'+me.uid;
  }
  function noteDocs(col,docs){
    if(col==='chits')docs.forEach(function(d){K.chits[d.id]=1;});
    if(col==='parties')docs.forEach(function(d){var v=d.data();K.parties[d.id]=(v&&(v._g||v.cid))||d.id;});
  }
  function strip(o){var r={};Object.keys(o||{}).forEach(function(k){if(k!=='_g'&&k!=='_w')r[k]=o[k];});return r;}
  function wrap(d,col){return {id:d.id,data:function(){var o=strip(d.data());if(col==='chits'){if(isAdmin&&o._o===undefined)o._o=me.uid;if(invCache[d.id])o.inv=invCache[d.id];}return o;}};}
  var markedDeleting={},lastChits={},invCache={},invsLoaded=false,reEmitChits=null,migrating={};

  /* ---- codes index: the admin publishes each join code so a member can find her chit ---- */
  var pubKey={},codeBan=null;
  function sleep(ms){return new Promise(function(r){setTimeout(r,ms);});}
  function setCode(code,cid,mid){
    var ref=fs.collection('codes').doc(code),n=0;
    function go(){return ref.set({cid:cid,mid:mid}).catch(function(e){if(n++<2&&!(e&&e.code==='permission-denied'))return sleep(900).then(go);throw e;});}
    return go();
  }
  function showCodeWarn(err){
    if(!err){if(codeBan){codeBan.remove();codeBan=null;}return;}
    if(!codeBan){
      codeBan=el('<div id="kmcodewarn" style="position:fixed;left:10px;right:10px;top:10px;z-index:60;background:#fde8e8;color:#8a1c1c;border:2px solid #d94b4b;border-radius:14px;padding:10px 12px;font:700 14px/1.4 system-ui"><div id="kmcwt"></div><button id="kmcwb" style="margin-top:8px;border:0;border-radius:10px;background:#8a1c1c;color:#fff;padding:8px 14px;font:700 14px system-ui">Try again</button></div>');
      document.body.appendChild(codeBan);
      codeBan.querySelector('#kmcwb').onclick=function(){republishAll(true);};
    }
    codeBan.querySelector('#kmcwt').textContent='Warning: the join codes could not be saved on the website ('+err+'). Members cannot join until this is fixed. Check that the Firebase rules are published, then tap Try again.';
  }
  /* write every code of a chit and report the ones that failed */
  function publishCodes(id,inv){
    var list=Object.keys(inv||{}).map(function(m){return [inv[m],m];});
    return Promise.all(list.map(function(p){return setCode(p[0],id,p[1]).then(function(){return null;},function(e){return {code:p[0],err:(e&&e.code)||String(e)};});})).then(function(r){return r.filter(Boolean);});
  }
  function syncCodes(id,data,oldInv){
    var old=oldInv||(lastChits[id]&&lastChits[id].inv)||{},nu=(data&&data.inv)||{},seen={},dels=[];
    Object.keys(nu).forEach(function(mid){seen[nu[mid]]=1;});
    Object.keys(old).forEach(function(mid){var code=old[mid];if(!seen[code])dels.push(fs.collection('codes').doc(code).delete().catch(function(){}));});
    if(!data)return Promise.all(dels);
    pubKey[id]=JSON.stringify(nu);
    return Promise.all(dels).then(function(){return publishCodes(id,nu);}).then(function(bad){showCodeWarn(bad.length?bad[0].err:'');});
  }
  /* each time the admin opens the website, make sure every chit's codes are on the website (old chits too) */
  function ensureCodes(id,data,force){
    var nu=(data&&data.inv)||{},key=JSON.stringify(nu);
    if(!Object.keys(nu).length||(!force&&pubKey[id]===key))return Promise.resolve([]);
    pubKey[id]=key;
    return publishCodes(id,nu).then(function(bad){showCodeWarn(bad.length?bad[0].err:'');if(bad.length)delete pubKey[id];return bad;});
  }
  function republishAll(force){
    return Promise.all(Object.keys(lastChits).map(function(id){return ensureCodes(id,lastChits[id],force);}));
  }
  /* is this code on the website? */
  function checkCode(code){
    return fs.collection('codes').doc(code).get().then(function(d){return d.exists?'ok':'missing';},function(e){return (e&&e.code)||'error';});
  }

  /* ---- the db the app sees ---- */
  function collection(col){
    if(col==='shots'||col==='dms'){
      /* screenshots are opened one at a time by id (the rules show each one only to its owner, the winner and the treasurer); private chats are not on the website yet */
      return {doc:function(id){var ref=fs.collection(col).doc(id);return {
        set:function(data){var d=JSON.parse(JSON.stringify(data));d._g=groupOf(col,id,data);d._w=me.uid;return ref.set(d);},
        delete:function(){return ref.delete();},
        get:function(){return ref.get().then(function(r){return {exists:r.exists,id:r.id,data:function(){return strip(r.data());}};});}};},
        onSnapshot:function(cb){setTimeout(function(){cb({docs:[]});},0);return function(){};}};
    }
    return {
      doc:function(id){
        var ref=fs.collection(col).doc(id);
        return {
          set:function(data){
            if(col==='chits'&&!canMake&&!K.own[id]&&!(data&&data._o===me.uid)){if(window.__kmShowLock)window.__kmShowLock();return Promise.reject(Object.assign(new Error('locked'),{code:'permission-denied'}));}
            var oldInv=null,inv=null,stripInv=false;
            if(col==='chits'){
              /* the join codes live in their own record (invs), seen only by the treasurer: members' copy of the chit must not hold everyone's codes */
              if(data&&data.inv===undefined&&invCache[id])data=Object.assign({},data,{inv:invCache[id]});
              inv=data&&data.inv?data.inv:null;
              /* the codes are taken out of the chit only once their own record is known to work (invCache); until then they stay in the chit and are moved by migrateInv */
              stripInv=!!(inv&&invCache[id]);
              K.chits[id]=1;K.own[id]=1;oldInv=(lastChits[id]&&lastChits[id].inv)||{};lastChits[id]=data;
            }
            var g=groupOf(col,id,data),d=JSON.parse(JSON.stringify(data));d._g=g;
            if(stripInv)delete d.inv;
            if(col==='parties')K.parties[id]=g;
            if(col==='chits'&&!d._o)d._o=me.uid;
            if(col==='shots')d._w=me.uid;
            return ref.set(d).then(function(){
              if(col==='chits'){
                runSyncs();
                if(inv){if(stripInv){invCache[id]=inv;fs.collection('invs').doc(id).set({inv:inv,_g:id,_o:d._o}).catch(function(){});}syncCodes(id,data,oldInv);}
              }
            });
          },
          delete:function(){
            if(col==='chits'){
              var pr=syncCodes(id,null,(lastChits[id]&&lastChits[id].inv)||{});delete lastChits[id];delete K.own[id];delete invCache[id];
              return pr.then(function(){return fs.collection('invs').doc(id).delete().catch(function(){});}).then(function(){return ref.delete();});
            }
            /* the log can only be removed while the whole chit is being deleted: mark the chit first (this cannot be undone) */
            if(col==='ledger'){
              var cid0=String(id).split('_')[0];
              if(!markedDeleting[cid0])markedDeleting[cid0]=fs.collection('chits').doc(cid0).update({status:'deleting'}).catch(function(){});
              return markedDeleting[cid0].then(function(){return ref.delete();});
            }
            return ref.delete();
          },
          get:function(){return ref.get().then(function(r){return {exists:r.exists,id:r.id,data:function(){return strip(r.data());}};});}
        };
      },
      onSnapshot:function(cb,errcb){return listen(col,cb,errcb);}
    };
  }
  function runSyncs(){accessWait.forEach(function(f){f();});}
  var stamped={};
  /* the chits this person runs: found from the chits she owns. The admin also claims old chits that have no owner yet. */
  /* old chits kept the codes inside the chit: move them into the treasurer-only record once, then take them out of the chit */
  function migrateInv(id,v){
    var o=v._o||me.uid;
    fs.collection('invs').doc(id).set({inv:v.inv,_g:id,_o:o}).then(function(){
      invCache[id]=v.inv;
      /* take only the codes out of the chit (an update of one field, so a change made at the same moment is not overwritten) */
      return fs.collection('chits').doc(id).update({inv:firebase.firestore.FieldValue.delete()});
    }).catch(function(){delete migrating[id];});
  }
  function watchInvs(){
    var q=isAdmin?fs.collection('invs'):fs.collection('invs').where('_o','==',me.uid);
    q.onSnapshot(function(s){
      s.docs.forEach(function(d){
        var iv=(d.data()||{}).inv||{};invCache[d.id]=iv;
        if(lastChits[d.id]){lastChits[d.id]=Object.assign({},lastChits[d.id],{inv:iv});ensureCodes(d.id,Object.assign({},lastChits[d.id],{_o:me.uid}));}
      });
      invsLoaded=true;if(reEmitChits)reEmitChits();
    },function(){invsLoaded=true;});
  }
  function noteOwned(docs){
    var now={},present={},changed=false;
    docs.forEach(function(d){
      var v=d.data();present[d.id]=1;
      if(v._o===undefined&&isAdmin&&!stamped[d.id]){stamped[d.id]=1;fs.collection('chits').doc(d.id).update({_o:me.uid}).catch(function(){delete stamped[d.id];});}
      if(d.metadata&&d.metadata.hasPendingWrites)return;
      now[d.id]=1;
      if(v.inv&&!migrating[d.id]){migrating[d.id]=1;migrateInv(d.id,v);}
      var iv=invCache[d.id]||v.inv;
      lastChits[d.id]=iv?Object.assign({},v,{inv:iv}):v;
      if(iv)ensureCodes(d.id,Object.assign({},v,{_o:me.uid,inv:iv}));
    });
    Object.keys(now).forEach(function(id){if(!K.own[id]){K.own[id]=1;changed=true;}});
    Object.keys(K.own).forEach(function(id){if(!present[id]){delete K.own[id];changed=true;}});
    if(changed)runSyncs();
  }
  function wantGroups(){
    var a=accessG.slice();
    Object.keys(K.own).forEach(function(c){if(a.indexOf(c)<0)a.push(c);});
    a.push('_u_'+me.uid);return a;
  }
  function listen(col,cb,errcb){
    /* one listener per group this person may read (her own chits, chits she joined, her own notes), merged into one list */
    var subs={},bag={},tries={},dead=false,first=false;
    function emit(){
      var all=[];Object.keys(bag).forEach(function(g){all=all.concat(bag[g]);});
      var seen={};all=all.filter(function(d){if(seen[d.id])return false;seen[d.id]=1;return true;});
      noteDocs(col,all);cb({docs:all.map(function(d){return wrap(d,col);})});
    }
    if(col==='chits')reEmitChits=emit;
    function attach(key,q,own){
      var opt=own?{includeMetadataChanges:true}:{};
      subs[key]=q.onSnapshot(opt,function(s){
        var docs=s.docs;
        if(own){
          if(isAdmin)docs=docs.filter(function(d){var o=d.data()._o;return o===undefined||o===me.uid;});
          bag[key]=docs;emit();noteOwned(docs);return;
        }
        bag[key]=docs;emit();
      },function(e){
        lastLoadErr=col+': '+((e&&e.code)||String(e));
        try{delete subs[key];}catch(_){}
        /* a read refused right after a save or a join: try again a few times */
        if(e&&e.code==='permission-denied'&&!dead){
          tries[key]=(tries[key]||0)+1;
          if(tries[key]<=5){setTimeout(function(){if(!dead)sync();},1200*tries[key]);return;}
        }
        if(errcb&&!(e&&e.code==='permission-denied'&&key!=='__own'&&key!=='_u_'+me.uid))errcb(e);
      });
    }
    function sync(){
      if(dead)return;
      var want;
      if(col==='chits'){
        if(!subs.__own)attach('__own',isAdmin?fs.collection('chits'):fs.collection('chits').where('_o','==',me.uid),true);
        want=accessG.slice().concat(['__own']);
        accessG.forEach(function(g){if(!subs[g])attach(g,fs.collection(col).where('_g','==',g),false);});
      }else{
        want=wantGroups();
        want.forEach(function(g){if(!subs[g])attach(g,fs.collection(col).where('_g','==',g),false);});
      }
      Object.keys(subs).forEach(function(g){if(want.indexOf(g)<0){subs[g]();delete subs[g];delete bag[g];emit();}});
      if(!first){first=true;emit();}
    }
    accessWait.push(sync);if(accessLoaded)sync();
    return function(){dead=true;Object.keys(subs).forEach(function(g){subs[g]();});};
  }
  function changed(){try{if(window.__kmUnlockChanged)window.__kmUnlockChanged();}catch(e){}}
  /* who may run chits: the admin, and the people the admin unlocked (treasurers/{uid}) */
  function watchUnlock(){
    canMake=isAdmin;
    fs.collection('treasurers').doc(me.uid).onSnapshot(function(s){unlockedDoc=!!s.exists;canMake=isAdmin||unlockedDoc;changed();},function(){});
    fs.collection('requests').doc(me.uid).onSnapshot(function(s){myReq=s.exists?s.data():null;changed();},function(){});
    if(isAdmin)reqUnsub=fs.collection('requests').onSnapshot(function(s){reqs=s.docs.map(function(d){var v=d.data();return {uid:d.id,name:v.name||'',contact:v.contact||'',at:v.at||'',status:v.status||''};});changed();},function(){});
  }
  function watchAccess(){
    accessUnsub=fs.collection('access').doc(me.uid).onSnapshot({includeMetadataChanges:true},function(s){
      /* wait until the server has really saved the access (a local copy is not enough: the server would still refuse the reads) */
      if(s.metadata&&s.metadata.hasPendingWrites)return;
      accessG=(s.exists&&s.data().g)||[];accessLoaded=true;accessWait.forEach(function(f){f();});
    },function(){accessG=[];accessLoaded=true;accessWait.forEach(function(f){f();});});
  }

  /* ---- joining with a code ---- */
  /* returns {ok:true} or {ok:false, why, detail}: why = format | notfound | codes-read | access-read | access-write | load */
  function ecode(e){return (e&&e.code)||String(e&&e.message||e).slice(0,60);}
  async function redeem(code){
    code=String(code||'').normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g,'');
    if(code.length!==6)return {ok:false,why:'format'};
    var cd;try{cd=await fs.collection('codes').doc(code).get();}catch(e){return {ok:false,why:'codes-read',detail:ecode(e)};}
    if(!cd.exists)return {ok:false,why:'notfound'};
    var cid=cd.data().cid,mid=cd.data().mid;
    if(K.own[cid])return {ok:true,cid:cid,mid:mid};
    var cur=[],mm={};
    try{var ad=await fs.collection('access').doc(me.uid).get();cur=(ad.exists&&ad.data().g)||[];mm=(ad.exists&&ad.data().mm)||{};}catch(e){return {ok:false,why:'access-read',detail:ecode(e)};}
    /* the member map (who am I in this chit) is saved with the join. People who joined before also get it the next time they type their code. */
    if(cur.indexOf(cid)<0||mm[cid]!==mid){
      var mm2=Object.assign({},mm);mm2[cid]=mid;
      try{await fs.collection('access').doc(me.uid).set({g:cur.indexOf(cid)<0?cur.concat([cid]):cur,code:code,mm:mm2});}catch(e){return {ok:false,why:'access-write',detail:ecode(e)};}
      if(cur.indexOf(cid)<0)cur=cur.concat([cid]);
    }
    if(accessG.indexOf(cid)<0){accessG=accessG.concat([cid]);accessWait.forEach(function(f){f();});}
    for(var i=0;i<70;i++){if(K.chits[cid])break;await sleep(200);}
    if(!K.chits[cid])return {ok:false,why:'load',detail:lastLoadErr||'timeout'};
    await sleep(350);
    try{var reg=JSON.parse(localStorage.getItem('km_codes')||'{}');reg[code]={cid:cid,mid:mid};localStorage.setItem('km_codes',JSON.stringify(reg));}catch(e){}
    return {ok:true,cid:cid,mid:mid};
  }
  window.__KMW={invsLoaded:function(){return invsLoaded;},lookup:function(code){code=String(code||'').normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g,'');try{var r=JSON.parse(localStorage.getItem('km_codes')||'{}')[code];return r?{cid:r.cid,mid:r.mid}:null;}catch(e){return null;}},redeem:redeem,checkCode:checkCode,republish:function(){return republishAll(true);},owner:function(){return isAdmin;},unlocked:function(){return canMake;},isAdmin:function(){return isAdmin;},requests:function(){return reqs;},approve:function(u){return fs.collection('treasurers').doc(u).set({at:new Date().toISOString()}).then(function(){return fs.collection('requests').doc(u).update({status:'ok'}).catch(function(){});});},revoke:function(u){return fs.collection('treasurers').doc(u).delete().then(function(){return fs.collection('requests').doc(u).update({status:'denied'}).catch(function(){});});},deny:function(u){return fs.collection('requests').doc(u).update({status:'denied'});},myReq:function(){return myReq;},ask:function(){return fs.collection('requests').doc(me.uid).set({name:me.displayName||'',contact:me.email||me.phoneNumber||'',at:new Date().toISOString()});},owns:function(cid){return !!K.own[cid];},mine:function(c){return !!c&&!!me&&(c._o===me.uid||(c._o===undefined&&(!!K.own[c.id]||isAdmin)));},uid:function(){return me&&me.uid;}};

  /* ---- what the app asks for ---- */
  function saveFile(o){
    var b=new Blob([o.data],{type:'text/plain;charset=utf-8'}),a=document.createElement('a');
    a.href=URL.createObjectURL(b);a.download=o.filename||'file.txt';document.body.appendChild(a);a.click();
    setTimeout(function(){URL.revokeObjectURL(a.href);a.remove();},500);return Promise.resolve();
  }
  window.claude={use:function(name){
    return ready.then(function(){
      if(name==='db')return {collection:collection};
      if(name==='user')return {isOwner:function(){return true;},can:function(){return true;},id:function(){return me.uid;},me:function(){return {id:me.uid,name:me.displayName||''};}};
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
      me=u;isAdmin=!!OWNER&&String(u.email||'').toLowerCase()===OWNER&&u.emailVerified!==false;
      hideGate();signOutBtn();
      watchAccess();watchUnlock();watchInvs();
      readyRes(true);
    });
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
})();
