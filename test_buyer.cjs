const fs=require('fs'),vm=require('vm'),assert=require('assert');
const nodes=new Map();function node(){return {value:'',hidden:false,disabled:false,checked:false,textContent:'',children:[],append(...v){this.children.push(...v)},replaceChildren(...v){this.children=v},querySelector(){return {focus(){}}},focus(){},reset(){for(const n of nodes.values()){n.value='';n.checked=false;}}};}
const el=id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id)};
let requests=[],lost=true;
let catalog={sale:{id:'sale-a',title:'Test',closed:false},lots:[{number:'1',title:'Un',status:'upcoming'},{number:'2',title:'Deux',status:'upcoming'}]};
const ctx={Intl,Date,Uint8Array,crypto:require('crypto').webcrypto,console,setTimeout(){},clearTimeout(){},setInterval(){},confirm:()=>true,window:{scrollTo(){},addEventListener(){}},document:{getElementById:el,createElement:node,addEventListener(){}},fetch:async(path,opts)=>{
 if(path==='/api/catalog')return {ok:true,json:async()=>structuredClone(catalog)};
 const data=JSON.parse(opts.body);requests.push(data);
 if(lost)throw Error('Connexion perdue');
 return {ok:true,json:async()=>({id:data.id,sale_id:data.sale_id,orders:data.items})};
}};
vm.createContext(ctx);const run=s=>vm.runInContext(s,ctx);
(async()=>{
run(fs.readFileSync('buyer.js','utf8'));await new Promise(setImmediate);
for(const [k,v] of Object.entries({name:'Camille',last_name:'Test',phone:'+33 06 12 34 56 78',phoneCountry:'33',email:'test@example.com',street:'1 rue test',city:'Paris',country:'France',lot:'1',maximum:'100'}))el(k).value=v;
el('add').onclick();el('lot').value='2';el('maximum').value='200';el('identity').onsubmit({preventDefault(){}});
assert.equal(run('pending.items.length'),2);assert.equal(run('pending.phone'),'+33612345678');
el('consent').checked=true;el('consent').onchange();el('continueAdmin').onclick();assert(!el('admin').hidden);
el('depositConfirmed').checked=true;el('adminCode').value='123';el('adminCode').oninput();
await el('submit').onclick();assert(run('uncertain'));assert(el('backConfirmation').disabled);const id=run('pending.id');
el('backConfirmation').onclick();assert.equal(run('pending.id'),id);
lost=false;el('depositConfirmed').checked=true;el('adminCode').value='123';el('adminCode').oninput();await el('submit').onclick();
assert.equal(requests.length,2);assert.equal(requests[0].id,requests[1].id);assert(!el('receipt').hidden);
run('resetBuyer()');assert.equal(el('email').value,'');assert.equal(run('basket.length'),0);
catalog.sale={id:'sale-b',title:'Nouvelle',closed:false};await run('poll()');assert.equal(run('catalogue.sale.id'),'sale-b');
assert(el('message').textContent.includes('Nouvelle vente'));
catalog.sale.closed=true;await run('poll()');assert(el('review').disabled);
console.log('OK : dépôt multiple, étapes distinctes, retry sans doublon, confidentialité et changement de vente.');
})().catch(e=>{console.error(e);process.exitCode=1;});
