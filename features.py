"""Ventes, archives, réglages et dépôts groupés. Toutes les écritures sont transactionnelles."""
import json, uuid, re
from datetime import datetime, timezone

DEFAULT_STEPS=[
    {'below':101,'buttons':[5,10,20],'auto':10},
    {'below':200,'buttons':[10,20,50],'auto':10},
    {'below':300,'buttons':[10,20,50],'auto':20},
    {'below':500,'buttons':[20,50,100],'auto':50},
    {'below':1000,'buttons':[50,100,200],'auto':50},
    {'below':2000,'buttons':[100,200,500],'auto':100},
    {'below':None,'buttons':[100,200,500],'auto':200},
]
def now(): return datetime.now(timezone.utc).isoformat()
def put(c,key,value):
    c.execute('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)',(key,json.dumps(value,ensure_ascii=False)))
def get(c,key):
    return json.loads(c.execute('SELECT value FROM settings WHERE key=?',(key,)).fetchone()[0])
def init(c):
    c.executescript("""
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS archives(id TEXT PRIMARY KEY,title TEXT NOT NULL,closed TEXT NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY,sale_id TEXT NOT NULL,payload TEXT NOT NULL,result TEXT NOT NULL);
    """)
    for key,value in [('sale',{'id':str(uuid.uuid4()),'title':'Vente de démonstration','closed':False}),('steps',DEFAULT_STEPS)]:
        c.execute('INSERT OR IGNORE INTO settings VALUES(?,?)',(key,json.dumps(value)))
    cols={r[1] for r in c.execute('PRAGMA table_info(orders)')}
    for field in ['batch_id','address_details']:
        if field not in cols: c.execute(f"ALTER TABLE orders ADD COLUMN {field} TEXT NOT NULL DEFAULT ''")
def public(c): return {'sale':get(c,'sale'),'steps':get(c,'steps')}
def snapshot(c):
    return {**public(c),'lots':[dict(r) for r in c.execute('SELECT * FROM lots ORDER BY position')],
            'orders':[dict(r) for r in c.execute('SELECT * FROM orders ORDER BY created,rowid')],
            'events':[dict(r) for r in c.execute('SELECT * FROM events ORDER BY id')]}
def archive(c):
    sale=get(c,'sale')
    if not sale['closed']:
        c.execute('INSERT INTO archives VALUES(?,?,?,?)',(sale['id'],sale['title'],now(),json.dumps({**snapshot(c),'sale':{**sale,'closed':True}},ensure_ascii=False)))
        sale['closed']=True;put(c,'sale',sale)
    return sale
def new_sale(c,title):
    sale=get(c,'sale')
    if not sale['closed']: raise ValueError('Clôturez et archivez la vente avant d’en créer une nouvelle.')
    if not isinstance(title,str) or not 1<=len(title.strip())<=120: raise ValueError('Nom de vente requis (120 caractères maximum).')
    c.execute('DELETE FROM orders');c.execute('DELETE FROM events')
    c.execute("UPDATE lots SET price=0,status='upcoming',leader='external',version=version+1")
    put(c,'sale',{'id':str(uuid.uuid4()),'title':title.strip(),'closed':False})
def validate_steps(rows):
    if not isinstance(rows,list) or not 1<=len(rows)<=20: raise ValueError('Entre 1 et 20 tranches sont nécessaires.')
    previous=0
    for i,row in enumerate(rows):
        if not isinstance(row,dict): raise ValueError('Tranche invalide.')
        bound=row.get('below');buttons=row.get('buttons');auto=row.get('auto')
        if i==len(rows)-1:
            if bound is not None: raise ValueError('La dernière tranche doit être sans limite.')
        elif type(bound) is not int or not previous<bound<=99999999: raise ValueError('Les seuils doivent être croissants.')
        if bound is not None: previous=bound
        if not isinstance(buttons,list) or not 1<=len(buttons)<=5 or any(type(n) is not int or not 1<=n<=99999999 for n in buttons) or len(set(buttons))!=len(buttons):
            raise ValueError('Chaque tranche demande 1 à 5 pas positifs distincts.')
        if type(auto) is not int or auto not in buttons: raise ValueError('Le pas automatique doit figurer dans les boutons.')
    return rows
def batch(c,data):
    key=str(uuid.UUID(data.get('id','')))
    # Un reçu peut être retrouvé après clôture sans réinsérer les ordres.
    payload={k:v for k,v in data.items() if k not in ('admin_code','deposit_confirmed')}
    encoded=json.dumps(payload,sort_keys=True,ensure_ascii=False)
    old=c.execute('SELECT * FROM batches WHERE id=?',(key,)).fetchone()
    if old:
        if old['payload']!=encoded: raise ValueError('Identifiant déjà utilisé : recommencez après vérification.')
        return 200,json.loads(old['result'])
    sale=get(c,'sale')
    if sale['closed'] or data.get('sale_id')!=sale['id']: raise ValueError('La vente a changé ou est clôturée. Recommencez votre dépôt.')
    contact={}
    for field,limit in [('name',60),('last_name',80),('phone',40),('email',254)]:
        value=data.get(field)
        if not isinstance(value,str) or not 1<=len(value.strip())<=limit: raise ValueError('Coordonnées incomplètes ou trop longues.')
        contact[field]=value.strip()
    if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+',contact['email']): raise ValueError('Adresse email invalide.')
    if not re.fullmatch(r'\+[0-9]{7,15}',contact['phone']): raise ValueError('Téléphone international invalide.')
    address=data.get('address_details')
    if not isinstance(address,dict): raise ValueError('Adresse requise.')
    clean={}
    for field,limit in [('street',160),('extra',160),('postal',30),('city',100),('country',80)]:
        v=address.get(field,'')
        if not isinstance(v,str) or len(v.strip())>limit or (field in ('street','city','country') and not v.strip()): raise ValueError('Adresse incomplète ou trop longue.')
        clean[field]=v.strip()
    items=data.get('items')
    if not isinstance(items,list) or not 1<=len(items)<=100: raise ValueError('Choisissez entre 1 et 100 lots.')
    seen=set();created=now();result=[]
    for item in items:
        if not isinstance(item,dict): raise ValueError('Ordre invalide.')
        number=item.get('lot');maximum=item.get('maximum')
        if not isinstance(number,str) or number in seen: raise ValueError('Un seul ordre par lot dans ce dépôt.')
        seen.add(number)
        if type(maximum) is not int or not 1<=maximum<=99999999: raise ValueError('Plafond entier positif requis.')
        lot=c.execute('SELECT * FROM lots WHERE number=?',(number,)).fetchone()
        if not lot or lot['status'] in ('sold','passed') or maximum<=lot['price']: raise ValueError('Lot '+number+' indisponible ou plafond dépassé. Modifiez votre sélection.')
        oid=str(uuid.uuid4())
        c.execute('INSERT INTO orders(id,lot,name,maximum,created,last_name,phone,email,address,approved_at,batch_id,address_details) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
          (oid,number,contact['name'],maximum,created,contact['last_name'],contact['phone'],contact['email'],', '.join(v for v in clean.values() if v),created,key,json.dumps(clean,ensure_ascii=False)))
        result.append({'id':oid,'lot':number})
    receipt={'id':key,'sale_id':sale['id'],'created':created,'orders':result}
    c.execute('INSERT INTO batches VALUES(?,?,?,?)',(key,sale['id'],encoded,json.dumps(receipt)))
    return 201,receipt
