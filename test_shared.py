import unittest, tempfile, threading, json, urllib.request, urllib.error, uuid, time
from pathlib import Path
import server

class SharedTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();server.DB=Path(cls.temp.name)/'test.sqlite3';server.initialize()
        cls.http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler);threading.Thread(target=cls.http.serve_forever,daemon=True).start()
        cls.url='http://127.0.0.1:'+str(cls.http.server_port)
        server.SESSIONS['test-session']=time.time()+3600
    @classmethod
    def tearDownClass(cls):cls.http.shutdown();cls.http.server_close();cls.temp.cleanup()
    def req(self,path,data=None):
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

    def test_multiple_orders(self):
        for name in ['A','B']:
            self.req('/api/orders',{'id':str(uuid.uuid4()),'lot':'2','name':name,'maximum':100})
        self.req('/api/action',{'lot':'2','version':0,'action':'price','price':80})
        result=self.req('/api/recommend',{'lot':'2','step':10})[1]
        self.assertNotIn('amount',result);self.assertIn('Plusieurs',result['reason'])

if __name__=='__main__':unittest.main()
