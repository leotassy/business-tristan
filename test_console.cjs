const fs=require('fs'),vm=require('vm'),assert=require('assert');
const html=fs.readFileSync('index.html','utf8'),source=html.match(/<script>\s*([\s\S]*?)<\/script>/)[1],shared=fs.readFileSync('shared.js','utf8');
const nodes=new Map();function node(){return {value:'add',checked:false,dataset:{},classList:{toggle(){}},setAttribute(){},replaceChildren(){},appendChild(){},append(){},addEventListener(){},insertAdjacentHTML(){},scrollIntoView(){},focus(){}}}
const app=node();let db,fail=false,delayed=null;
const ctx={Intl,Date,console,location:{protocol:'http:'},confirm:()=>true,setInterval(){},document:{getElementById(id){if(!nodes.has(id))nodes.set(id,node());return nodes.get(id)},querySelector(){return app},querySelectorAll(){return []},createElement:node,addEventListener(){}},window:{addEventListener(){}},fetch:async(path,opts)=>{
 if(delayed&&path==='/api/state')return await delayed;
 if(fail)throw Error('offline');
 if(path==='/api/action'){const data=JSON.parse(opts.body),lot=db.find(l=>l.number===data.lot);lot.price=data.price;lot.status='active';lot.canUndo=true;lot.history.push({message:'Serveur',time:new Date().toISOString()});}
 return {ok:true,status:200,json:async()=>path==='/api/recommend'?{reason:'Aucun ordre'}:{lots:JSON.parse(JSON.stringify(db))}};
}};
vm.createContext(ctx);const run=s=>vm.runInContext(s,ctx);
(async()=>{run(source);db=JSON.parse(run('JSON.stringify(lots)'));run('typeNumber(9)');assert.equal(run('typedPrice'),'');
run(shared);await new Promise(setImmediate);
assert.equal(run('connected'),true);assert.equal(app.inert,false);
run('typedPrice="475"');await run('validatePrice()');assert.equal(run('lots[0].price'),475);
run('typedPrice="8"');await run('validatePrice()');assert.equal(run('lots[0].price'),483);assert.equal(run('lots[0].history.length'),2);assert.equal(nodes.get('undo').disabled,false);
fail=true;run('typedPrice="5"');await run('validatePrice()');assert.equal(run('lots[0].price'),483);assert.equal(run('lots[0].history.length'),2);assert.equal(app.inert,true);
fail=false;await run('refresh()');
let resolveOld;delayed=new Promise(resolve=>resolveOld=resolve);
const oldRefresh=run('refresh()');delayed=null;
run('typedPrice="7"');await run('validatePrice()');
assert.equal(run('lots[0].price'),490);
resolveOld({ok:true,status:200,json:async()=>({lots:db.map(l=>({...l,price:1}))})});
await oldRefresh;assert.equal(run('lots[0].price'),490);
assert(!/localStorage|STORAGE_KEY|lastAction|function record\(|restore\(/.test(source));
console.log('OK : démarrage verrouillé, prix initial, ajout, journal serveur, canUndo et échec réseau sans mutation locale.');
})().catch(e=>{console.error(e);process.exitCode=1});
