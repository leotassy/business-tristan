import unittest, tempfile, threading, json, urllib.request, urllib.error, uuid, time
from pathlib import Path
import server

CONTACT = dict(last_name="Nom confidentiel", phone="+33 6 00 00 00 00", email="test@example.com", address="1 rue des Tests, Ville fictive")

class SharedTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();server.DB=Path(cls.temp.name)/'test.sqlite3';server.initialize()
        cls.http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler);threading.Thread(target=cls.http.serve_forever,daemon=True).start()
        cls.url='http://127.0.0.1:'+str(cls.http.server_port)
        server.SESSIONS['test-session']=time.time()+3600
    @classmethod
    def tearDownClass(cls):cls.http.shutdown();cls.http.server_close();cls.temp.cleanup()
    def req(self,path,data=None,contact_defaults=True):
        if path=="/api/orders" and contact_defaults: data={**CONTACT,"admin_code":server.ADMIN_PIN,"deposit_confirmed":True,**data}
        r=urllib.request.Request(self.url+path,data=json.dumps(data).encode() if data is not None else None,headers={'Content-Type':'application/json','Cookie':'clerk=test-session'})
        try:
            with urllib.request.urlopen(r) as response:return response.status,json.load(response)
        except urllib.error.HTTPError as e:return e.code,json.load(e)
    def test_access(self):
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(self.url+'/api/state')
        self.assertEqual(error.exception.code,401)
        self.assertEqual(self.req('/api/login',{'pin':'wrong'})[0],403)
        self.assertEqual(self.req('/api/login',{'pin':server.PIN})[0],200)

    def test_full_flow(self):
        code,lots=self.req('/api/lots');self.assertEqual(code,200);self.assertIn('5 bis',[l['number'] for l in lots])
        order={'id':str(uuid.uuid4()),'lot':'6','name':'Camille','maximum':100}
        self.assertEqual(self.req('/api/orders',order)[0],201)
        self.assertEqual(self.req('/api/orders',order)[0],200)
        code,state=self.req('/api/state');lot=next(l for l in state['lots'] if l['number']=='6');self.assertEqual(lot['orders'],1);self.assertNotIn('maximum',json.dumps(state))
        self.assertEqual(self.req('/api/action',{'lot':'6','version':0,'action':'price','price':80})[0],200)
        _,proposal=self.req('/api/recommend',{'lot':'6','step':10});self.assertEqual(proposal['amount'],90)
        action={'lot':'6','version':1,'action':'defend','step':10,'expectedAmount':90,'orderId':order['id']}
        self.assertEqual(self.req('/api/action',action)[0],200);self.assertEqual(self.req('/api/action',action)[0],409)
        self.assertNotIn('amount',self.req('/api/recommend',{'lot':'6','step':10})[1])
        self.assertEqual(self.req('/api/action',{'lot':'6','version':2,'action':'undo'})[0],200)
        self.assertEqual(self.req('/api/action',{'lot':'6','version':3,'action':'price','price':100})[0],200)
        self.assertNotIn('amount',self.req('/api/recommend',{'lot':'6','step':10})[1])
        self.req('/api/action',{'lot':'6','version':4,'action':'sold'})
        order['id']=str(uuid.uuid4());order['maximum']=150;self.assertEqual(self.req('/api/orders',order)[0],400)
        self.assertEqual(self.req('/data/auction.sqlite3')[0],404)
        self.assertEqual(self.req('/api/orders',{'id':str(uuid.uuid4()),'lot':'1','name':'A','maximum':-1})[0],400)
        server.initialize();self.assertEqual(next(l for l in self.req('/api/state')[1]['lots'] if l['number']=='6')['status'],'sold')
    def test_leo_limit(self):
        order={'id':str(uuid.uuid4()),'lot':'4','name':'Léo','maximum':2000}
        self.assertEqual(self.req('/api/orders',order)[0],201)
        self.req('/api/action',{'lot':'4','version':0,'action':'price','price':1800})
        proposal=self.req('/api/recommend',{'lot':'4'})[1]
        self.assertEqual(proposal['amount'],1900);self.assertNotIn('name',proposal);self.assertNotIn('atLimit',proposal);self.assertNotIn('maximum',proposal)
        self.req('/api/action',{'lot':'4','version':1,'action':'defend','step':None,'expectedAmount':1900,'orderId':order['id']})
        self.assertNotIn('amount',self.req('/api/recommend',{'lot':'4'})[1])
        self.req('/api/action',{'lot':'4','version':2,'action':'price','price':1950})
        proposal=self.req('/api/recommend',{'lot':'4'})[1]
        self.assertEqual(proposal['amount'],2000);self.assertNotIn('atLimit',proposal)
        self.assertEqual(self.req('/api/action',{'lot':'4','version':3,'action':'defend','expectedAmount':2000,'orderId':order['id']})[0],200)
        self.req('/api/action',{'lot':'4','version':4,'action':'price','price':2100})
        self.assertNotIn('amount',self.req('/api/recommend',{'lot':'4'})[1])

    def test_anonymous_200(self):
        order={'id':str(uuid.uuid4()),'lot':'3','name':'Prénom confidentiel','maximum':200}
        self.req('/api/orders',order)
        self.req('/api/action',{'lot':'3','version':0,'action':'price','price':180})
        proposal=self.req('/api/recommend',{'lot':'3'})[1]
        self.assertEqual(proposal['amount'],190);self.assertNotIn('name',proposal);self.assertNotIn('maximum',proposal)
        self.req('/api/action',{'lot':'3','version':1,'action':'defend','expectedAmount':190,'orderId':order['id']})
        self.req('/api/action',{'lot':'3','version':2,'action':'price','price':195})
        proposal=self.req('/api/recommend',{'lot':'3'})[1]
        self.assertEqual(proposal['amount'],200);self.assertNotIn('atLimit',proposal)
        self.req('/api/action',{'lot':'3','version':3,'action':'defend','expectedAmount':200,'orderId':order['id']})
        self.assertNotIn('Prénom confidentiel',json.dumps(self.req('/api/state')[1]))
        self.req('/api/action',{'lot':'3','version':4,'action':'price','price':210})
        self.assertNotIn('amount',self.req('/api/recommend',{'lot':'3'})[1])

    def test_contact_details(self):
        order={**CONTACT,'id':str(uuid.uuid4()),'lot':'8','name':'Identité privée','maximum':500}
        for field in ('name',*CONTACT):
            invalid={**order,'admin_code':server.ADMIN_PIN,'deposit_confirmed':True,field:' '}
            self.assertEqual(self.req('/api/orders',invalid,False)[0],400)
        for field,value in [('email','incorrect'),('phone','abc')]:
            self.assertEqual(self.req('/api/orders',{**order,field:value})[0],400)
        self.assertEqual(self.req('/api/orders',order)[0],201)
        self.assertEqual(self.req('/api/orders',order)[0],200)
        self.assertEqual(self.req('/api/orders',{**order,'email':'other@example.com'})[0],400)
        server.initialize()
        with server.connect() as c:
            saved=dict(c.execute('SELECT * FROM orders WHERE id=?',(order['id'],)).fetchone())
        for field in ('name',*CONTACT): self.assertEqual(saved[field],order[field])
        self.req('/api/action',{'lot':'8','version':0,'action':'price','price':100})
        proposal=self.req('/api/recommend',{'lot':'8'})[1]
        action=self.req('/api/action',{'lot':'8','version':1,'action':'defend','expectedAmount':proposal['amount'],'orderId':order['id']})[1]
        exposed=json.dumps([self.req('/api/state')[1],self.req('/api/lots')[1],proposal,action],ensure_ascii=False)
        for field in ('name',*CONTACT): self.assertNotIn(order[field],exposed)

    def test_admin_approval(self):
        order={**CONTACT,'id':str(uuid.uuid4()),'lot':'7','name':'Test','maximum':100}
        self.assertEqual(self.req('/api/orders',order,False)[0],403)
        self.assertEqual(self.req('/api/orders',{**order,'admin_code':'incorrect'})[0],403)
        self.assertEqual(self.req('/api/orders',{**order,'deposit_confirmed':False})[0],400)
        with server.connect() as c:
            self.assertIsNone(c.execute('SELECT id FROM orders WHERE id=?',(order['id'],)).fetchone())
        self.assertEqual(self.req('/api/orders',order)[0],201)
        with server.connect() as c:
            saved=dict(c.execute('SELECT * FROM orders WHERE id=?',(order['id'],)).fetchone())
            self.assertTrue(saved['approved_at'])
            self.assertNotIn('admin_code',saved)
        for _ in range(5):
            self.assertEqual(self.req('/api/orders',{**order,'admin_code':'incorrect'})[0],403)
        self.assertEqual(self.req('/api/orders',order)[0],429)
        server.ADMIN_ATTEMPTS.clear()

    def test_z_reset_sale(self):
        request=urllib.request.Request(self.url+'/api/reset',data=b'{"confirm":"RESET"}',headers={'Content-Type':'application/json'})
        with self.assertRaises(urllib.error.HTTPError) as error: urllib.request.urlopen(request)
        self.assertEqual(error.exception.code,401)
        self.assertEqual(self.req('/api/reset',{})[0],400)
        with server.connect() as c:
            before=c.execute('SELECT count(*) FROM orders').fetchone()[0]
            version=c.execute("SELECT version FROM lots WHERE number='1'").fetchone()[0]
        self.assertGreater(before,0)
        code,result=self.req('/api/reset',{'confirm':'RESET'})
        self.assertEqual(code,200)
        for lot in result['lots']:
            self.assertEqual(lot['price'],0)
            self.assertEqual(lot['orders'],0)
            self.assertEqual(lot['history'],[])
            self.assertEqual(lot['status'],'upcoming')
            self.assertFalse(lot['canUndo'])
        self.assertEqual(result['lots'][0]['number'],'1')
        self.assertEqual(result['lots'][0]['version'],version+1)
        backups=list((server.DB.parent/'sauvegardes').glob('*.sqlite3'))
        self.assertEqual(len(backups),1)
        with server.sqlite3.connect(backups[0]) as c:
            self.assertEqual(c.execute('SELECT count(*) FROM orders').fetchone()[0],before)

    def test_multiple_orders(self):
        first=str(uuid.uuid4()); second=str(uuid.uuid4())
        for key,name in [(first,'A'),(second,'B')]:
            self.assertEqual(self.req('/api/orders',{'id':key,'lot':'2','name':name,'maximum':100})[0],201)
        # Même horodatage : l’ordre d’insertion reste déterminant, pas l’UUID.
        with server.connect() as c:
            c.execute("UPDATE orders SET created='2026-01-01' WHERE lot='2'")
        self.req('/api/action',{'lot':'2','version':0,'action':'price','price':80})
        result=self.req('/api/recommend',{'lot':'2','step':10})[1]
        self.assertEqual(result['orderId'],first)
        self.assertEqual(result['amount'],90)
        self.req('/api/action',{'lot':'2','version':1,'action':'defend','step':10,'expectedAmount':90,'orderId':first})
        self.assertNotIn('amount',self.req('/api/recommend',{'lot':'2'})[1])
        self.req('/api/action',{'lot':'2','version':2,'action':'price','price':95})
        result=self.req('/api/recommend',{'lot':'2','step':10})[1]
        self.assertEqual(result['orderId'],first)
        self.assertEqual(result['amount'],100)
        self.req('/api/action',{'lot':'2','version':3,'action':'defend','step':10,'expectedAmount':100,'orderId':first})
        self.req('/api/action',{'lot':'2','version':4,'action':'sold'})
        lot=next(l for l in self.req('/api/state')[1]['lots'] if l['number']=='2')
        self.assertEqual(lot['leader'],first)

    def test_different_limits(self):
        for maximum in [100,200]:
            self.req('/api/orders',{'id':str(uuid.uuid4()),'lot':'5','name':'Test','maximum':maximum})
        self.req('/api/action',{'lot':'5','version':0,'action':'price','price':80})
        result=self.req('/api/recommend',{'lot':'5'})[1]
        self.assertNotIn('amount',result)


if __name__=='__main__':unittest.main()
