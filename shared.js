// Mode serveur local : SQLite fait autorité. Le mode fichier historique est conservé.
if (location.protocol !== 'file:') {
  let busy=false, connected=false, proposal=null, generation=0;
  const oldRender=renderLot;
  async function api(path,data) {
    const response=await fetch(path,data ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)} : {});
    const value=await response.json(); if(response.status===401){location.replace('/connexion');throw Error('Session expirée.')} if(!response.ok)throw Error(value.error||'Serveur indisponible.'); return value;
  }
  function lock() {
    if(busy||!connected) document.querySelectorAll('.key,.bid-step,#validate,#sold,#passed,#undo,#defend,#previous,#next,#customPrice,#lotSelect').forEach(b=>b.disabled=true);
    $('defend').disabled=busy||!connected||Boolean(typedPrice)||!proposal?.amount;
  }
  async function recommend() {
    const token=++generation, number=lots[currentLotIndex].number; proposal=null;lock();
    if(!connected)return;
    try {const value=await api('/api/recommend',{lot:number,step:$('autoStep').checked ? null : Number($('defendStep').value)});
      if(token!==generation||number!==lots[currentLotIndex].number)return;
      proposal=value;
      if ($('autoStep').checked && value.step) $('defendStep').value=value.step;
      $('proposal').textContent=value.amount ? `Ordre anonyme ${value.reference} : ${formatPrice(value.amount)}` : value.reason;
      $('proposal').style.color='#183f73';
      $('proposal').style.fontWeight='650';
      $('sharedOrders').classList.toggle('available',Boolean(value.amount));
      $('defend').textContent=value.amount ? `Enchère annoncée à ${formatPrice(value.amount)}` : 'Aucun ordre à défendre';lock();
    } catch(e) { if(token===generation){proposal=null;$('proposal').textContent='Vérification des ordres indisponible.';lock();} }
  }
  renderLot=function(){oldRender();$('lotSelect').disabled=busy||!connected;$('customPrice').disabled=busy||!connected||['sold','passed'].includes(lots[currentLotIndex].status);$('undo').disabled=!lots[currentLotIndex].canUndo;lock();recommend()};
  const oldUpdate=updateInput;updateInput=function(){oldUpdate();lock()};
  save=function(){};exportSession=function(){notify('En mode partagé, la session est conservée dans la base locale. Les plafonds ne sont pas exportés par la console.')};
  async function refresh() {
    if(busy)return;
    try { const value=await api('/api/state'); if(busy)return;
      value.lots.forEach((lot,i)=>Object.assign(lots[i],lot));connected=true;
      $('saveState').textContent='Base partagée · connectée';renderLot();
    } catch(e){connected=false;proposal=null;$('saveState').textContent='Serveur indisponible · actions suspendues';lock();}
  }
  async function act(action,extra={}) {
    if(busy||!connected)return false;
    const index=currentLotIndex, lot=lots[index];busy=true;lock();
    try{const value=await api('/api/action',{action,lot:lot.number,version:lot.version,...extra});
      value.lots.forEach((l,i)=>Object.assign(lots[i],l));typedPrice='';$('entryMode').value='add';
      if(['sold','passed'].includes(action)&&$('autoNext').checked&&index<lots.length-1)currentLotIndex=index+1;
      notify(action==='defend'?'Enchère de l’ordre enregistrée.':'Action enregistrée dans la base partagée.');return true;
    }catch(e){notify(e.message);return false;}finally{busy=false;await refresh();}
  }
  validatePrice=async function(){const price=enteredPrice(),lot=lots[currentLotIndex];if(!typedPrice||!Number.isInteger(price)||price<=0||price>99999999)return;
    if(price===lot.price){notify('Ce prix est déjà enregistré.');return;}
    if(price<lot.price&&!confirm('Confirmer cette correction à la baisse ?'))return;
    await act('price',{price});};
  increasePrice=async function(step){const lot=lots[currentLotIndex];if(typedPrice||lot.price<=0||!getBidSteps(lot.price).includes(step)||lot.price+step>99999999)return;await act('price',{price:lot.price+step})};
  closeLot=async function(status){if(typedPrice){notify('Validez ou effacez la saisie avant de clôturer.');return;}await act(status)};
  undoLast=async function(){if(typedPrice){notify('Validez ou effacez la saisie avant de corriger.');return;}if(confirm('Corriger la dernière action sur ce lot ? La trace sera conservée.'))await act('undo')};
  $('defend').onclick=async()=>{if(typedPrice||!proposal?.amount)return;await act('defend',{step:$('autoStep').checked ? null : Number($('defendStep').value),expectedAmount:proposal.amount,orderId:proposal.orderId})};
  $('defendStep').onchange=recommend;
  $('autoStep').onchange=()=>{ $('defendStep').disabled=$('autoStep').checked; recommend(); };
  $('defendStep').disabled=true;
  $('sharedOrders').hidden=false;
  document.querySelector('.notice').textContent='Vente de démonstration · Saisie manuelle des enchères · Ordres partagés';
  document.querySelector('.orders-subtext').textContent='déposés sur ce lot';
  document.querySelectorAll('.section-label').forEach(e=>{if(e.textContent.includes('Ordres fictifs'))e.textContent='Ordres enregistrés'});
  document.querySelector('.orders-subtext + .hint').textContent='Ordres anonymes : seuls la référence et le montant à défendre sont affichés.';
  document.querySelector('.connection').insertAdjacentHTML('beforeend',' <a href="/acheteur" target="_blank" rel="noopener">Page acheteur ↗</a>');
  typedPrice='';currentLotIndex=0;lots.forEach(l=>{l.price=0;l.status='upcoming';l.orders=0;l.history=[]});
  lock();refresh();setInterval(refresh,2000);
}
