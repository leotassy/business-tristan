"""Prototype local uniquement. Lancer : python3 server.py. Aucune connexion Interencheres."""
import features
import json, sqlite3, os, uuid, secrets, time, socket, sys, re
from http.cookies import SimpleCookie
from datetime import datetime, timezone
from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

ROOT = Path(__file__).resolve().parent
DB = Path(os.environ.get('AUCTION_DB', str(ROOT / 'data' / 'auction.sqlite3')))

PIN = os.environ.get('AUCTION_PIN') or str(secrets.randbelow(900000)+100000)
ADMIN_PIN = os.environ.get('AUCTION_ADMIN_PIN') or str(secrets.randbelow(90000000)+10000000)
ADMIN_ATTEMPTS = {}
SESSIONS = {}
ADMIN_SESSIONS = {}
ATTEMPTS = {}
LAN_IP = None
PUBLIC_ORIGIN = os.environ.get('AUCTION_PUBLIC_ORIGIN','').rstrip('/')

def connect():
    con = sqlite3.connect(DB, timeout=10)
    con.row_factory = sqlite3.Row
    con.execute('PRAGMA foreign_keys=ON')
    return con

def initialize():
    DB.parent.mkdir(exist_ok=True)
    with connect() as c:
        c.executescript('''CREATE TABLE IF NOT EXISTS lots (number TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, position INTEGER NOT NULL, price INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'upcoming', leader TEXT NOT NULL DEFAULT 'external', version INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, lot TEXT NOT NULL REFERENCES lots(number), name TEXT NOT NULL, maximum INTEGER NOT NULL CHECK(maximum>0), created TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_orders_lot ON orders(lot);
        CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, lot TEXT NOT NULL REFERENCES lots(number), message TEXT NOT NULL, time TEXT NOT NULL, before_state TEXT NOT NULL, reversible INTEGER NOT NULL DEFAULT 1);''')
        columns={row[1] for row in c.execute('PRAGMA table_info(orders)')}
        for field in ('last_name','phone','email','address'):
            if field not in columns: c.execute(f"ALTER TABLE orders ADD COLUMN {field} TEXT NOT NULL DEFAULT ''")
        if 'approved_at' not in columns:
            c.execute("ALTER TABLE orders ADD COLUMN approved_at TEXT")
        features.init(c)
        for i, lot in enumerate(json.loads((ROOT/'lots.json').read_text())):
            c.execute('INSERT OR IGNORE INTO lots(number,title,description,position) VALUES(?,?,?,?)', (lot['number'],lot['title'],lot['description'],i))

def now(): return datetime.now(timezone.utc).isoformat()
def amount(value):
    if type(value) is not int or not 0 < value <= 99999999: raise ValueError('Montant entier attendu, entre 1 et 99 999 999 €.')
    return value

def suggested_step(price,c):
    for row in features.get(c,'steps'):
        if row['below'] is None or price<row['below']: return row['auto']

def recommendation(c, lot, step=None):
    if lot['status'] in ('sold','passed') or not lot['price']: return {'reason':'Validez le prix initial du lot.'}
    if lot['leader'] != 'external': return {'reason':'Un ordre mène déjà. Attendez une nouvelle enchère de la salle ou du live.'}
    step = suggested_step(lot['price'],c) if step is None else amount(step)
    eligible=c.execute('SELECT id,maximum FROM orders WHERE lot=? AND maximum>? ORDER BY created,rowid',(lot['number'],lot['price'])).fetchall()
    if len({order['maximum'] for order in eligible})>1: return {'reason':'Plusieurs ordres peuvent enchérir : arbitrage à valider avec le commissaire-priseur.'}
    if not eligible: return {'reason':'Aucun ordre disponible au-dessus du prix actuel.'}
    order=eligible[0]
    target=min(lot['price']+step,order['maximum'])
    return {'amount':target,'orderId':order['id'],'reference':order['id'][:8], 'step':step, 'reason':'Confirmez uniquement après annonce de l’enchère.'}

def state(c):
    result=[]
    for row in c.execute('SELECT * FROM lots ORDER BY position').fetchall():
        lot=dict(row); lot['orders']=c.execute('SELECT count(*) FROM orders WHERE lot=?',(lot['number'],)).fetchone()[0]
        lot['history']=[dict(e) for e in c.execute('SELECT message,time FROM events WHERE lot=? ORDER BY id DESC',(lot['number'],))]
        lot['canUndo']=bool(c.execute('SELECT reversible FROM events WHERE lot=? ORDER BY id DESC LIMIT 1',(lot['number'],)).fetchone() or False)
        e=c.execute('SELECT reversible FROM events WHERE lot=? ORDER BY id DESC LIMIT 1',(lot['number'],)).fetchone()
        lot['canUndo']=bool(e and e[0]); result.append(lot)
    return result

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def send(self, code, value, mime='application/json; charset=utf-8'):
        data=json.dumps(value,ensure_ascii=False).encode() if mime.startswith('application/json') else value
        self.send_response(code); self.send_header('Content-Type',mime);
        if getattr(self,'new_cookie',None): self.send_header('Set-Cookie',self.new_cookie)
        self.send_header('Referrer-Policy','no-referrer'); self.send_header('Content-Length',str(len(data))); self.send_header('Cache-Control','no-store'); self.send_header('X-Content-Type-Options','nosniff'); self.send_header('X-Frame-Options','DENY'); self.end_headers(); self.wfile.write(data)
    def valid_host(self):
        return self.headers.get('Host') in [host+':'+str(self.server.server_port) for host in ('127.0.0.1','localhost',LAN_IP) if host]
    def authenticated(self,admin=False):
        try:
            cookie=SimpleCookie(self.headers.get('Cookie','')); token=cookie['admin' if admin else 'clerk'].value
            return (ADMIN_SESSIONS if admin else SESSIONS).get(token,0)>time.time()
        except (KeyError,ValueError): return False
    def do_GET(self):
        if not self.valid_host(): return self.send(403,{'error':'Accès local uniquement.'})
        path=self.path.split('?')[0]
        if path=='/api/catalog':
            with connect() as c: return self.send(200,{**features.public(c),'lots':[dict(x) for x in c.execute('SELECT number,title,description,status FROM lots ORDER BY position')]})
        if path.startswith('/api/admin/'):
            if not self.authenticated(True): return self.send(401,{'error':'Connexion administrateur requise.'})
            with connect() as c:
                if path=='/api/admin/current': return self.send(200,features.snapshot(c))
                if path=='/api/admin/archives': return self.send(200,[dict(r) for r in c.execute('SELECT id,title,closed FROM archives ORDER BY closed DESC')])
                if path.startswith('/api/admin/archive/'):
                    row=c.execute('SELECT payload FROM archives WHERE id=?',(path.rsplit('/',1)[-1],)).fetchone()
                    return self.send(200,json.loads(row[0])) if row else self.send(404,{'error':'Archive introuvable.'})
            return self.send(404,{'error':'Page introuvable.'})
        if path=='/api/lots':
            with connect() as c: return self.send(200,[dict(x) for x in c.execute('SELECT number,title,description,status FROM lots ORDER BY position')])
        if path=='/api/state':
            if not self.authenticated(): return self.send(401,{'error':'Connectez-vous à la console secrétaire.'})
            with connect() as c: return self.send(200,{'lots':state(c),**features.public(c)})
        files={'/admin':'admin.html','/admin.js':'admin.js','/buyer.js':'buyer.js','/app.css':'app.css','/connexion':'login.html','/':'index.html','/index.html':'index.html','/acheteur':'buyer.html','/buyer.html':'buyer.html','/shared.js':'shared.js','/network.js':'network.js'}
        if path not in files: return self.send(404,{'error':'Page introuvable.'})
        file=ROOT/('login.html' if path in ('/','/index.html') and not self.authenticated() else files[path]); self.send(200,file.read_bytes(),'text/javascript; charset=utf-8' if file.suffix=='.js' else 'text/css; charset=utf-8' if file.suffix=='.css' else 'text/html; charset=utf-8')
    def do_POST(self):
        origin=self.headers.get('Origin')
        if not self.valid_host() or (origin and origin not in filter(None, ('http://'+self.headers.get('Host',''),PUBLIC_ORIGIN))) or self.headers.get('Content-Type','').split(';')[0]!='application/json': return self.send(403,{'error':'Requête refusée.'})
        try:
            size=int(self.headers.get('Content-Length','0'))
            if not 0<size<=10000: raise ValueError('Requête trop volumineuse.')
            data=json.loads(self.rfile.read(size))
            if not isinstance(data,dict): raise ValueError('Requête invalide.')
            if self.path=='/api/login':
                address=self.client_address[0]; attempts,until=ATTEMPTS.get(address,(0,0))
                if until>time.time(): return self.send(429,{'error':'Trop de tentatives. Réessayez dans une minute.'})
                if not secrets.compare_digest(str(data.get('pin','')),PIN):
                    attempts=attempts+1 if until else 1
                    ATTEMPTS[address]=(attempts,time.time()+60 if attempts>=5 else time.time()-1)
                    return self.send(403,{'error':'Code incorrect.'})
                ATTEMPTS.pop(address,None); token=secrets.token_urlsafe(32); SESSIONS[token]=time.time()+43200
                self.new_cookie='clerk='+token+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200'+ ('; Secure' if PUBLIC_ORIGIN and origin==PUBLIC_ORIGIN else '')
                return self.send(200,{'ok':True})
            if self.path in ('/api/action','/api/recommend','/api/reset') and not self.authenticated(): return self.send(401,{'error':'Session secrétaire expirée. Reconnectez-vous.'})
            if self.path in ('/api/orders','/api/batch','/api/admin/login'):
                address=self.client_address[0]; attempts,until=ADMIN_ATTEMPTS.get(address,(0,0))
                if until>time.time(): return self.send(429,{'error':'Trop de tentatives. Réessayez dans une minute.'})
                code=data.get('admin_code')
                if not isinstance(code,str) or not secrets.compare_digest(code.encode(),ADMIN_PIN.encode()):
                    attempts=attempts+1 if until else 1
                    ADMIN_ATTEMPTS[address]=(attempts,time.time()+60 if attempts>=5 else time.time()-1)
                    return self.send(403,{'error':'Code administrateur requis ou incorrect.'})
                ADMIN_ATTEMPTS.pop(address,None)
                if self.path=='/api/admin/login':
                    token=secrets.token_urlsafe(32);ADMIN_SESSIONS[token]=time.time()+1800
                    self.new_cookie='admin='+token+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800'+ ('; Secure' if PUBLIC_ORIGIN and origin==PUBLIC_ORIGIN else '')
                    return self.send(200,{'ok':True})
                if data.get('deposit_confirmed') is not True:
                    raise ValueError('L’administrateur doit confirmer la vérification de la caution en personne.')
            if self.path.startswith('/api/admin/') and not self.authenticated(True):
                return self.send(401,{'error':'Connexion administrateur requise.'})
            if self.path=='/api/admin/logout':
                cookie=SimpleCookie(self.headers.get('Cookie',''));ADMIN_SESSIONS.pop(cookie['admin'].value,None)
                self.new_cookie='admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'
                return self.send(200,{'ok':True})
            with connect() as c:
                c.execute('BEGIN IMMEDIATE')
                if self.path=='/api/batch':
                    code,result=features.batch(c,data);c.commit();return self.send(code,result)
                if self.path in ('/api/admin/close','/api/admin/new','/api/admin/steps'):
                    sale=features.get(c,'sale')
                    if data.get('sale_id')!=sale['id']: raise ValueError('La vente a changé. Rechargez la page.')
                    if self.path=='/api/admin/close': features.archive(c)
                    elif self.path=='/api/admin/new': features.new_sale(c,data.get('title'))
                    else:
                        if sale['closed']: raise ValueError('Créez une nouvelle vente avant de modifier les pas.')
                        features.put(c,'steps',features.validate_steps(data.get('steps')))
                    c.commit();return self.send(200,features.public(c))

                if self.path=='/api/reset':
                    if data.get('confirm') != 'RESET': raise ValueError('Confirmation de réinitialisation requise.')
                    backup_dir=DB.parent/'sauvegardes'
                    backup_dir.mkdir(exist_ok=True)
                    backup=backup_dir/(DB.stem+'-avant-reset-'+uuid.uuid4().hex+'.sqlite3')
                    # Le verrou de transaction empêche toute écriture pendant la sauvegarde.
                    with connect() as reader, sqlite3.connect(backup) as destination:
                        reader.backup(destination)
                    features.archive(c)
                    features.new_sale(c,'Vente de démonstration')
                    c.execute('DELETE FROM orders')
                    c.execute('DELETE FROM events')
                    c.commit()
                    return self.send(200,{'lots':state(c),**features.public(c)})
                if features.get(c,'sale')['closed']: raise ValueError('Vente clôturée. Créez une nouvelle vente dans l’espace administrateur.')
                if self.path=='/api/orders':
                    key=str(uuid.UUID(data.get('id',''))); name=data.get('name','')
                    if not isinstance(name,str) or not 1<=len(name.strip())<=60: raise ValueError('Prénom requis (60 caractères maximum).')
                    contact={}
                    for field,limit in [('last_name',80),('phone',40),('email',254),('address',500)]:
                        value=data.get(field)
                        if not isinstance(value,str) or not 1<=len(value.strip())<=limit: raise ValueError('Nom, téléphone, email et adresse sont obligatoires et doivent respecter les longueurs maximales.')
                        contact[field]=value.strip()
                    if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+',contact['email']): raise ValueError('Adresse email invalide.')
                    phone=contact['phone']
                    if not re.fullmatch(r'[+0-9 ().-]+',phone) or not 7<=len(re.sub(r'\D','',phone))<=15: raise ValueError('Numéro de téléphone invalide.')
                    maximum=amount(data.get('maximum')); number=data.get('lot')
                    previous=c.execute('SELECT * FROM orders WHERE id=?',(key,)).fetchone()
                    if previous:
                        if (previous['lot'],previous['name'],previous['maximum'])!=(number,name.strip(),maximum) or any(previous[k]!=v for k,v in contact.items()): raise ValueError('Identifiant déjà utilisé pour un autre ordre.')
                        return self.send(200,{'id':key,'created':previous['created']})
                    lot=c.execute('SELECT * FROM lots WHERE number=?',(number,)).fetchone()
                    if not lot or lot['status'] in ('sold','passed'): raise ValueError('Ce lot n’accepte plus d’ordres.')
                    if maximum<=lot['price']: raise ValueError('Le plafond doit dépasser le prix actuel.')
                    created=now(); c.execute('INSERT INTO orders(id,lot,name,maximum,created,last_name,phone,email,address,approved_at) VALUES(?,?,?,?,?,?,?,?,?,?)',(key,number,name.strip(),maximum,created,contact['last_name'],contact['phone'],contact['email'],contact['address'],created)); c.commit()
                    return self.send(201,{'id':key,'created':created})
                if self.path not in ('/api/action','/api/recommend'): return self.send(404,{'error':'Action inconnue.'})
                lot=c.execute('SELECT * FROM lots WHERE number=?',(data.get('lot'),)).fetchone()
                if not lot: raise ValueError('Lot introuvable.')
                if self.path=='/api/recommend': return self.send(200,recommendation(c,lot,data.get('step')))
                if data.get('version')!=lot['version']: return self.send(409,{'error':'Ce lot a changé. Vérifiez le nouveau prix avant de recommencer.'})
                action=data.get('action'); price,status,leader=lot['price'],lot['status'],lot['leader']
                before=json.dumps(dict(lot)); reversible=1
                if action=='undo':
                    e=c.execute('SELECT * FROM events WHERE lot=? ORDER BY id DESC LIMIT 1',(lot['number'],)).fetchone()
                    if not e or not e['reversible']: raise ValueError('Aucune action à corriger.')
                    old=json.loads(e['before_state']); price,status,leader=old['price'],old['status'],old['leader']; message='Correction : annulation de « '+e['message']+' »'; reversible=0
                else:
                    if status in ('sold','passed'): raise ValueError('Lot clôturé.')
                    if action=='price':
                        price=amount(data.get('price')); status='active'; leader='external'; message=f'Prix salle / live : {price} €'
                    elif action=='defend':
                        proposal=recommendation(c,lot,data.get('step'))
                        if not proposal.get('amount') or proposal['amount']!=data.get('expectedAmount') or proposal['orderId']!=data.get('orderId'): raise ValueError('Proposition modifiée. Vérifiez les ordres et réessayez.')
                        price=proposal['amount']; leader=proposal['orderId'];status='active';message=f"Ordre anonyme {proposal['reference']} défendu à {price} €"
                    elif action in ('sold','passed'):
                        if action=='sold' and price<=0: raise ValueError('Validez un prix avant l’adjudication.')
                        status=action;message=f'Adjugé à {price} €' if action=='sold' else 'Lot passé'
                    else: raise ValueError('Action inconnue.')
                c.execute('UPDATE lots SET price=?,status=?,leader=?,version=version+1 WHERE number=?',(price,status,leader,lot['number']))
                c.execute('INSERT INTO events(lot,message,time,before_state,reversible) VALUES(?,?,?,?,?)',(lot['number'],message,now(),before,reversible));c.commit()
                return self.send(200,{'lots':state(c),**features.public(c)})
        except (ValueError,TypeError,json.JSONDecodeError) as e: self.send(400,{'error':str(e) or 'Données invalides.'})
        except sqlite3.Error: self.send(503,{'error':'Base indisponible. Réessayez sans fermer la page.'})

if __name__=='__main__':
    initialize()
    if '--lan' in sys.argv:
        try:
            LAN_IP=socket.gethostbyname(socket.gethostname())
            if LAN_IP.startswith('127.'): LAN_IP=None
        except OSError: pass
        LAN_IP=os.environ.get('AUCTION_LAN_IP',LAN_IP)
    server=ThreadingHTTPServer(('0.0.0.0' if '--lan' in sys.argv else '127.0.0.1',int(os.environ.get('AUCTION_PORT','8765'))),Handler)
    print(f'Console : http://127.0.0.1:{server.server_port}/ — Acheteur : http://127.0.0.1:{server.server_port}/acheteur',flush=True)
    print('Code secrétaire : '+PIN,flush=True)
    print('Code administrateur (validation des ordres) : '+ADMIN_PIN,flush=True)
    if LAN_IP: print('Tablettes : http://'+LAN_IP+':8765/acheteur et http://'+LAN_IP+':8765/',flush=True)
    server.serve_forever()
