const $=id=>document.getElementById(id), money=n=>new Intl.NumberFormat('fr-FR',{style:'currency',currency:'EUR',maximumFractionDigits:0}).format(n);
let catalogue=null,basket=[],pending=null,busy=false,connected=false,receiptTimer,lastActivity=Date.now(),checking=false,uncertain=false;
const countries=[['France','33'],['Inde','91'],['Belgique','32'],['Suisse','41'],['Luxembourg','352'],['Allemagne','49'],['Espagne','34'],['Italie','39'],['Portugal','351'],['Royaume-Uni','44'],['États-Unis / Canada','1'],['Maroc','212'],['Algérie','213'],['Tunisie','216'],['Autre pays','']];
for(const [name,dial] of countries){const option=document.createElement('option');option.value=dial;option.textContent=name+(dial?' (+'+dial+')':'');$('phoneCountry').append(option);const o=document.createElement('option');o.value=name;$('countries').append(o);}
$('phone').value='+33 ';
$('phoneCountry').onchange=()=>{$('phone').value='+'+$('phoneCountry').value+' ';$('phone').focus();};
function newId(){const a=crypto.getRandomValues(new Uint8Array(16));a[6]=(a[6]&15)|64;a[8]=(a[8]&63)|128;const h=Array.from(a,b=>b.toString(16).padStart(2,'0')).join('');return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);}
function show(id){for(const name of ['entry','confirmation','admin','receipt'])$(name).hidden=name!==id;$('message').textContent='';$(id).querySelector('h2')?.focus();window.scrollTo(0,0);}
function clearApproval(){$('adminCode').value='';$('depositConfirmed').checked=false;controls();}
function controls(){const unavailable=busy||!connected||!catalogue||catalogue.sale.closed;
$('review').disabled=unavailable;$('add').disabled=unavailable;$('continueAdmin').disabled=unavailable||!$('consent').checked;
$('submit').disabled=unavailable||!pending||!$('consent').checked||!$('depositConfirmed').checked||!$('adminCode').value;
for(const id of ['back','backConfirmation','cancel','again'])$(id).disabled=busy||(uncertain&&id!=='again');
}
function renderBasket(){ $('basket').replaceChildren();basket.forEach((item,index)=>{const li=document.createElement('li');li.textContent='Lot '+item.lot+' — '+money(item.maximum);const b=document.createElement('button');b.type='button';b.textContent='Retirer';b.className='secondary';b.onclick=()=>{basket.splice(index,1);pending=null;renderBasket();};li.append(b);$('basket').append(li);});}
function showLot(){const l=catalogue?.lots.find(l=>l.number===$('lot').value);$('title').textContent=l?.title||'';$('description').textContent=l?.description||'';}
function resetBuyer(){clearTimeout(receiptTimer);basket=[];pending=null;uncertain=false;$('identity').reset();$('phone').value='+33 ';$('consent').checked=false;clearApproval();renderBasket();for(const id of ['confirmName','confirmPhone','confirmEmail','confirmAddress','receiptDetails','receiptId'])$(id).textContent='';$('confirmOrders').replaceChildren();lastActivity=Date.now();show('entry');showLot();controls();}
async function poll(){if(checking)return;checking=true;try{const r=await fetch('/api/catalog');if(!r.ok)throw Error();const next=await r.json();const changed=(catalogue&&catalogue.sale.id!==next.sale.id)||(pending&&pending.sale_id!==next.sale.id);
const previous=$('lot').value;catalogue=next;connected=true;$('saleTitle').textContent=next.sale.title;
$('lot').replaceChildren();for(const l of next.lots){const o=document.createElement('option');o.value=l.number;o.textContent='Lot '+l.number+' — '+l.title;o.disabled=['sold','passed'].includes(l.status);$('lot').append(o);}
if(next.lots.some(l=>l.number===previous))$('lot').value=previous;
if(changed&&!busy){resetBuyer();$('message').textContent='Nouvelle vente : veuillez recommencer votre dépôt.';}
$('connection').textContent=next.sale.closed?'Vente clôturée — les dépôts sont fermés.':'Connecté à la vente';showLot();
}catch(e){connected=false;$('connection').textContent='Connexion interrompue — aucun nouvel envoi possible. Vos saisies restent ici pendant 5 minutes.';}finally{checking=false;controls();}}
function addLot(){const maximum=Number($('maximum').value),lot=$('lot').value;
if(!Number.isInteger(maximum)||maximum<1||maximum>99999999)throw Error('Indiquez un plafond entier positif.');
const l=catalogue.lots.find(l=>l.number===lot);if(!l||['sold','passed'].includes(l.status))throw Error('Ce lot est clôturé.');
if(basket.some(i=>i.lot===lot))throw Error('Ce lot est déjà sélectionné. Retirez-le pour changer son plafond.');
basket.push({lot,maximum});$('maximum').value='';pending=null;renderBasket();}
$('add').onclick=()=>{try{addLot();$('message').textContent='';}catch(e){$('message').textContent=e.message;}};
$('identity').onsubmit=e=>{e.preventDefault();if(!connected||busy||catalogue.sale.closed)return;try{
if($('maximum').value)addLot();if(!basket.length)throw Error('Ajoutez au moins un lot.');
const data={};for(const k of ['name','last_name','email'])data[k]=$(k).value.trim();
if(!data.name||!data.last_name||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email))throw Error('Vérifiez votre nom, prénom et email.');
const raw=$('phone').value.trim();if(!/^\+[0-9\s().-]+$/.test(raw))throw Error('Téléphone : commencez par + et l’indicatif du pays.');
data.phone=raw.replace(/[\s().-]/g,'');if($('phoneCountry').value==='33')data.phone=data.phone.replace(/^\+330/,'+33');if(!/^\+[0-9]{7,15}$/.test(data.phone))throw Error('Téléphone international incomplet (7 à 15 chiffres).');
data.address_details={};for(const k of ['street','extra','postal','city','country'])data.address_details[k]=$(k).value.trim();
if(!data.address_details.street||!data.address_details.city||!data.address_details.country)throw Error('Renseignez la rue, la ville et le pays.');
pending={...data,id:newId(),sale_id:catalogue.sale.id,items:basket.map(i=>({...i}))};
$('confirmName').textContent=data.last_name+' '+data.name;$('confirmPhone').textContent=data.phone;$('confirmEmail').textContent=data.email;$('confirmAddress').textContent=Object.values(data.address_details).filter(Boolean).join('\n');
$('confirmOrders').replaceChildren();for(const i of basket){const li=document.createElement('li');li.textContent='Lot '+i.lot+' — '+catalogue.lots.find(l=>l.number===i.lot).title+' : plafond '+money(i.maximum);$('confirmOrders').append(li);}
$('consent').checked=false;clearApproval();show('confirmation');controls();
}catch(error){$('message').textContent=error.message;}};
$('lot').onchange=showLot;
$('consent').onchange=controls;$('depositConfirmed').onchange=controls;$('adminCode').oninput=controls;
$('continueAdmin').onclick=()=>{if(!pending||!$('consent').checked)return;clearApproval();show('admin');};
$('back').onclick=()=>{if(busy||uncertain)return;pending=null;clearApproval();show('entry');};
$('backConfirmation').onclick=()=>{if(busy||uncertain)return;clearApproval();show('confirmation');};
$('submit').onclick=async()=>{if($('submit').disabled||busy)return;busy=true;uncertain=true;controls();$('message').textContent='Enregistrement…';try{
const r=await fetch('/api/batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...pending,admin_code:$('adminCode').value,deposit_confirmed:true})});
const result=await r.json();if(!r.ok){uncertain=false;throw Error(result.error);}uncertain=false;
show('receipt');$('receiptDetails').textContent=result.orders.length+' ordre(s) enregistré(s).'+(result.sale_id!==catalogue.sale.id?' Ce dépôt appartient à une vente précédente ; aucun nouvel ordre n’a été créé.':'');$('receiptId').textContent='Référence du dépôt : '+result.id;pending=null;receiptTimer=setTimeout(resetBuyer,20000);
}catch(e){$('message').textContent=e.message+(uncertain?' Résultat incertain : ressaisissez le code et réessayez ici, sans recharger la page. Le même dépôt ne sera pas créé deux fois.':'');}finally{busy=false;clearApproval();}};
$('cancel').onclick=()=>{if(confirm('Effacer ce formulaire et passer à l’acheteur suivant ?'))resetBuyer();};$('again').onclick=resetBuyer;
for(const event of ['pointerdown','keydown','input'])document.addEventListener(event,()=>lastActivity=Date.now());
setInterval(()=>{if(!busy&&Date.now()-lastActivity>300000){const wasUncertain=uncertain;resetBuyer();if(wasUncertain)$('message').textContent='Formulaire effacé. Un dépôt était en attente de confirmation : faites vérifier son enregistrement par l’administrateur avant de recommencer.';}},1000);
window.addEventListener('online',poll);window.addEventListener('offline',()=>{connected=false;controls();$('connection').textContent='Hors connexion — envoi suspendu.';});
window.addEventListener('pageshow',e=>{if(e.persisted)resetBuyer();});
poll();setInterval(poll,5000);
