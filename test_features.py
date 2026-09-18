import unittest, tempfile, threading, json, urllib.request, urllib.error, uuid, time
from pathlib import Path
import server, features

class FeaturesTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();server.DB=Path(self.temp.name)/'test.sqlite3';server.initialize()
        server.ADMIN_ATTEMPTS.clear()
        server.SESSIONS['clerk-test']=time.time()+3600;server.ADMIN_SESSIONS['admin-test']=time.time()+3600
        self.http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        threading.Thread(target=self.http.serve_forever,daemon=True).start()
        self.url='http://127.0.0.1:'+str(self.http.server_port)
    def tearDown(self):self.http.shutdown();self.http.server_close();self.temp.cleanup()
    def req(self,path,data=None,role='admin'):
        headers={'Content-Type':'application/json'}
        if role: headers['Cookie']=role+'='+role+'-test'
        request=urllib.request.Request(self.url+path,data=None if data is None else json.dumps(data).encode(),headers=headers)
        try:
            with urllib.request.urlopen(request) as r:return r.status,json.load(r)
        except urllib.error.HTTPError as e:return e.code,json.load(e)
    def order(self):
        sale=self.req('/api/catalog',role=None)[1]['sale']
        return dict(id=str(uuid.uuid4()),sale_id=sale['id'],name='Camille',last_name='Privé',phone='+33612345678',email='test@example.com',
          address_details=dict(street='1 rue fictive',extra='',postal='75000',city='Paris',country='France'),
          items=[dict(lot='1',maximum=100),dict(lot='2',maximum=200)],admin_code=server.ADMIN_PIN,deposit_confirmed=True)
    def test_batch_atomic_private_idempotent(self):
        data=self.order()
        invalid={**data,'items':[data['items'][0],dict(lot='absent',maximum=100)]}
        self.assertEqual(self.req('/api/batch',invalid,None)[0],400)
        self.assertEqual(len(self.req('/api/admin/current')[1]['orders']),0)
        self.assertEqual(self.req('/api/batch',{**data,'admin_code':'wrong'},None)[0],403)
        code,result=self.req('/api/batch',data,None);self.assertEqual(code,201)
        self.assertEqual(len(result['orders']),2)
        self.assertEqual(self.req('/api/batch',data,None),(200,result))
        self.assertEqual(self.req('/api/batch',{**data,'name':'Autre'},None)[0],400)
        snapshot=self.req('/api/admin/current')[1];self.assertEqual(len(snapshot['orders']),2)
        public=json.dumps(self.req('/api/state',role='clerk')[1],ensure_ascii=False)
        for value in ['Privé','test@example.com','+33612345678','rue fictive']: self.assertNotIn(value,public)
        for endpoint in ['/api/admin/current','/api/admin/archives','/api/admin/archive/test']:
            self.assertEqual(self.req(endpoint,role='clerk')[0],401)
        self.assertEqual(self.req('/api/admin/close',{'sale_id':data['sale_id']},'clerk')[0],401)
    def test_archive_new_sale_and_stale_submission(self):
        data=self.order();self.req('/api/batch',data,None)
        self.req('/api/action',dict(lot='1',version=0,action='price',price=80),'clerk')
        self.assertEqual(self.req('/api/admin/new',dict(sale_id=data['sale_id'],title='Next'))[0],400)
        self.assertEqual(self.req('/api/admin/close',dict(sale_id=data['sale_id']))[0],200)
        self.assertEqual(self.req('/api/batch',{**data,'id':str(uuid.uuid4())},None)[0],400)
        self.assertEqual(self.req('/api/action',dict(lot='1',version=1,action='price',price=90),'clerk')[0],400)
        self.assertEqual(len(self.req('/api/admin/archives')[1]),1)
        archive=self.req('/api/admin/archive/'+data['sale_id'])[1];self.assertEqual(len(archive['orders']),2);self.assertEqual(len(archive['events']),1)
        self.assertEqual(self.req('/api/admin/new',dict(sale_id=data['sale_id'],title='Nouvelle'))[0],200)
        current=self.req('/api/admin/current')[1];self.assertEqual(current['orders'],[]);self.assertEqual(current['lots'][0]['price'],0)
        self.assertNotEqual(current['sale']['id'],data['sale_id'])
        self.assertEqual(self.req('/api/batch',{**data,'id':str(uuid.uuid4())},None)[0],400)
        self.assertEqual(self.req('/api/batch',data,None)[0],200)
        self.assertEqual(self.req('/api/admin/current')[1]['orders'],[])
    def test_steps_and_login(self):
        self.assertEqual(self.req('/api/admin/login',{'admin_code':server.ADMIN_PIN},None)[0],200)
        sale=self.req('/api/catalog')[1]['sale']['id']
        rows=[dict(below=100,buttons=[3,5,10],auto=3),dict(below=None,buttons=[10,20],auto=10)]
        self.assertEqual(self.req('/api/admin/steps',dict(sale_id=sale,steps=rows))[0],200)
        self.req('/api/batch',self.order(),None)
        self.req('/api/action',dict(lot='1',version=0,action='price',price=20),'clerk')
        self.assertEqual(self.req('/api/recommend',dict(lot='1'),'clerk')[1]['amount'],23)
        self.assertEqual(self.req('/api/state',role='clerk')[1]['steps'],rows)
        self.assertEqual(self.req('/api/admin/steps',dict(sale_id=sale,steps=[dict(below=None,buttons=[-1],auto=-1)]))[0],400)
        server.initialize()
        self.assertEqual(self.req('/api/catalog')[1]['steps'],rows)
    def test_migrate_preserves_old_orders(self):
        with server.connect() as c:
            c.execute("INSERT INTO orders(id,lot,name,maximum,created) VALUES('old','1','Ancien',100,'2020')")
        server.initialize()
        self.assertEqual(self.req('/api/admin/current')[1]['orders'][0]['name'],'Ancien')

if __name__=='__main__':unittest.main()
