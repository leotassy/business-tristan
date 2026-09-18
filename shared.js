// Actions serveur uniquement. Aucune mutation locale des prix ou du journal.
  let proposal=null, generation=0, saleId=null, refreshGeneration=0;
  const clerkToken = (typeof URLSearchParams !== 'undefined' && typeof location !== 'undefined' && location.search ? new URLSearchParams(location.search).get('token') : null) ||
                     (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('clerk_token') : null);
  if (clerkToken && typeof sessionStorage !== 'undefined') {
    sessionStorage.setItem('clerk_token', clerkToken);
    if (typeof history !== 'undefined' && typeof location !== 'undefined' && typeof URLSearchParams !== 'undefined' && new URLSearchParams(location.search).has('token')) {
      history.replaceState(null, '', location.pathname);
    }
  }
  async function api(path,data) {
    const token = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('clerk_token') : null;
    const headers = {'Content-Type':'application/json'};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const response=await fetch(path,data ? {method:'POST',headers,body:JSON.stringify(data)} : {headers});
    const value=await response.json(); if(response.status===401){if(typeof sessionStorage!=='undefined')sessionStorage.removeItem('clerk_token');location.replace('/connexion');throw Error('Session expirée.')} if(!response.ok)throw Error(value.error||'Serveur indisponible.'); return value;
  }
  function lock() {
    document.querySelector('.app').inert=busy||!connected;
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
  function exportSession(){notify('La session est conservée dans la base serveur. Les plafonds ne sont pas exportés par la console.')}
  async function refresh() {
    if(busy)return;
    const token=++refreshGeneration;
    try { const value=await api('/api/state'); if(busy||token!==refreshGeneration)return;
      if(saleId&&value.sale&&saleId!==value.sale.id){currentLotIndex=0;typedPrice='';}
      saleId=value.sale?.id||saleId;configuredSteps=value.steps||configuredSteps;
      value.lots.forEach((lot,i)=>Object.assign(lots[i],lot));connected=!value.sale?.closed;
      if(!connected){generation++;proposal=null;$('saveState').textContent='Vente clôturée · ouvrez l’administration pour la suite';lock();return;}
      $('saveState').textContent='Base partagée · connectée';renderLot();
    } catch(e){if(token!==refreshGeneration)return;connected=false;generation++;proposal=null;$('saveState').textContent='Serveur indisponible · actions suspendues';lock();}
  }
  async function act(action,extra={}) {
    if(busy||!connected)return false;
    const index=currentLotIndex, lot=lots[index];busy=true;refreshGeneration++;lock();
    try{const value=await api('/api/action',{action,lot:lot.number,version:lot.version,...extra});
      value.lots.forEach((l,i)=>Object.assign(lots[i],l));typedPrice='';$('entryMode').value='add';
      if(['sold','passed'].includes(action)&&$('autoNext').checked&&index<lots.length-1)currentLotIndex=index+1;
      notify(action==='defend'?'Enchère de l’ordre enregistrée.':'Action enregistrée dans la base partagée.');return true;
    }catch(e){notify(e.message);return false;}finally{busy=false;await refresh();}
  }
  async function resetSale(){
    if(busy||!connected)return;
    if(!confirm('Réinitialiser toute la vente ? Les ordres et coordonnées des acheteurs, les prix et les historiques seront retirés de la vente en cours. Tous les lots repartiront à 0 €. Une sauvegarde sera conservée sur le serveur.'))return;
    busy=true;refreshGeneration++;generation++;proposal=null;lock();
    try{
      const value=await api('/api/reset',{confirm:'RESET'});
      value.lots.forEach((lot,i)=>Object.assign(lots[i],lot));
      currentLotIndex=0;typedPrice='';$('entryMode').value='add';
      notify('Vente réinitialisée : lot 1 à 0 €, aucun ordre. Sauvegarde conservée sur le serveur.');
    }catch(e){notify(e.message);}finally{busy=false;await refresh();}
  }
  async function validatePrice(){const price=enteredPrice(),lot=lots[currentLotIndex];if(!typedPrice||!Number.isInteger(price)||price<=0||price>99999999)return;
    if(price===lot.price){notify('Ce prix est déjà enregistré.');return;}
    if(price<lot.price&&!confirm('Confirmer cette correction à la baisse ?'))return;
    await act('price',{price});};
  async function increasePrice(step){const lot=lots[currentLotIndex];if(typedPrice||lot.price<=0||!getBidSteps(lot.price).includes(step)||lot.price+step>99999999)return;await act('price',{price:lot.price+step})};
  async function closeLot(status){if(typedPrice){notify('Validez ou effacez la saisie avant de clôturer.');return;}await act(status)};
  async function undoLast(){if(typedPrice){notify('Validez ou effacez la saisie avant de corriger.');return;}if(confirm('Corriger la dernière action sur ce lot ? La trace sera conservée.'))await act('undo')};
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
  lock();
  if(location.protocol==='file:'){
    $('saveState').textContent='Serveur requis';
    notify('Ouvrez la console via l’adresse HTTP du serveur, pas directement depuis le fichier HTML.');
  }else{renderLot();refresh();setInterval(refresh,2000);}
