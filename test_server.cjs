const assert = require('assert');
const http = require('http');

async function runTests() {
  const { app, server, PIN, ADMIN_PIN, lots, settings, clerkSessions, adminSessions } = await import('./server.js');

  const testServer = server && server.listening ? server : await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  const port = testServer.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  function request(path, options = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, baseUrl);
      const reqOpts = {
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers || {}),
        },
      };

      const req = http.request(url, reqOpts, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let body = data;
          try {
            body = JSON.parse(data);
          } catch (e) {}
          resolve({ status: res.statusCode, headers: res.headers, body });
        });
      });

      req.on('error', reject);
      if (options.body) {
        req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
      }
      req.end();
    });
  }

  console.log('Testing server endpoints...');

  // 1. Catalog
  const catRes = await request('/api/catalog');
  assert.equal(catRes.status, 200);
  assert.ok(catRes.body.sale);
  assert.ok(Array.isArray(catRes.body.lots));
  assert.ok(catRes.body.lots.length > 0);

  // 2. Lots
  const lotsRes = await request('/api/lots');
  assert.equal(lotsRes.status, 200);
  assert.ok(Array.isArray(lotsRes.body));

  // 3. Unauthorized access
  const stateUnauth = await request('/api/state');
  assert.equal(stateUnauth.status, 401);

  const adminUnauth = await request('/api/admin/current');
  assert.equal(adminUnauth.status, 401);

  // 4. Login as clerk
  const clerkLoginFail = await request('/api/login', {
    method: 'POST',
    body: { pin: 'wrong' },
  });
  assert.equal(clerkLoginFail.status, 403);

  const clerkLoginOk = await request('/api/login', {
    method: 'POST',
    body: { pin: PIN },
  });
  assert.equal(clerkLoginOk.status, 200);
  assert.ok(clerkLoginOk.body.ok);
  const clerkCookie = clerkLoginOk.headers['set-cookie'][0].split(';')[0];

  // 5. Access state with clerk cookie
  const stateAuth = await request('/api/state', {
    headers: { Cookie: clerkCookie },
  });
  assert.equal(stateAuth.status, 200);
  assert.ok(Array.isArray(stateAuth.body.lots));

  // 6. Login as admin
  const adminLoginOk = await request('/api/admin/login', {
    method: 'POST',
    body: { admin_code: ADMIN_PIN },
  });
  assert.equal(adminLoginOk.status, 200);
  const adminCookie = adminLoginOk.headers['set-cookie'][0].split(';')[0];

  const adminCurrent = await request('/api/admin/current', {
    headers: { Cookie: adminCookie },
  });
  assert.equal(adminCurrent.status, 200);
  assert.ok(adminCurrent.body.sale);

  // 7. Test batch order submission (idempotent, atomic)
  const batchId = 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d';
  const orderData = {
    id: batchId,
    sale_id: catRes.body.sale.id,
    name: 'Camille',
    last_name: 'Privé',
    phone: '+33612345678',
    email: 'test@example.com',
    address_details: {
      street: '1 rue fictive',
      extra: '',
      postal: '75000',
      city: 'Paris',
      country: 'France',
    },
    items: [
      { lot: '1', maximum: 100 },
      { lot: '2', maximum: 200 },
    ],
    admin_code: ADMIN_PIN,
    deposit_confirmed: true,
  };

  // Invalid lot in batch
  const invalidBatch = {
    ...orderData,
    items: [{ lot: 'absent', maximum: 100 }],
  };
  const invalidBatchRes = await request('/api/batch', {
    method: 'POST',
    body: invalidBatch,
  });
  assert.equal(invalidBatchRes.status, 400);

  // Wrong admin code
  const wrongCodeRes = await request('/api/batch', {
    method: 'POST',
    body: { ...orderData, admin_code: 'wrong' },
  });
  assert.equal(wrongCodeRes.status, 403);

  // Successful batch
  const batchOk = await request('/api/batch', {
    method: 'POST',
    body: orderData,
  });
  assert.equal(batchOk.status, 201);
  assert.equal(batchOk.body.orders.length, 2);

  // Idempotent retry returns 200 and same receipt
  const batchRetry = await request('/api/batch', {
    method: 'POST',
    body: orderData,
  });
  assert.equal(batchRetry.status, 200);
  assert.equal(batchRetry.body.id, batchId);

  // Modify data with same id -> 400
  const batchTamper = await request('/api/batch', {
    method: 'POST',
    body: { ...orderData, name: 'Autre' },
  });
  assert.equal(batchTamper.status, 400);

  // Privacy check: state should NOT expose private contact details
  const stateCheck = await request('/api/state', {
    headers: { Cookie: clerkCookie },
  });
  const stateStr = JSON.stringify(stateCheck.body);
  assert.ok(!stateStr.includes('Privé'));
  assert.ok(!stateStr.includes('test@example.com'));
  assert.ok(!stateStr.includes('+33612345678'));

  // 8. Secretary actions
  // Price update
  const priceAct = await request('/api/action', {
    method: 'POST',
    headers: { Cookie: clerkCookie },
    body: { lot: '1', version: 0, action: 'price', price: 80 },
  });
  assert.equal(priceAct.status, 200);

  // Recommendation
  const recRes = await request('/api/recommend', {
    method: 'POST',
    headers: { Cookie: clerkCookie },
    body: { lot: '1', step: 10 },
  });
  assert.equal(recRes.status, 200);
  assert.equal(recRes.body.amount, 90);

  // Defend bid
  const defendAct = await request('/api/action', {
    method: 'POST',
    headers: { Cookie: clerkCookie },
    body: {
      lot: '1',
      version: 1,
      action: 'defend',
      step: 10,
      expectedAmount: 90,
      orderId: recRes.body.orderId,
    },
  });
  assert.equal(defendAct.status, 200);

  // Undo action
  const undoAct = await request('/api/action', {
    method: 'POST',
    headers: { Cookie: clerkCookie },
    body: { lot: '1', version: 2, action: 'undo' },
  });
  assert.equal(undoAct.status, 200);

  // 9. Admin close and archive
  const closeRes = await request('/api/admin/close', {
    method: 'POST',
    headers: { Cookie: adminCookie },
    body: { sale_id: catRes.body.sale.id },
  });
  assert.equal(closeRes.status, 200);
  assert.equal(closeRes.body.sale.closed, true);

  // Action rejected when sale is closed
  const actionClosed = await request('/api/action', {
    method: 'POST',
    headers: { Cookie: clerkCookie },
    body: { lot: '1', version: 3, action: 'price', price: 90 },
  });
  assert.equal(actionClosed.status, 400);

  // Archives listing
  const archivesRes = await request('/api/admin/archives', {
    headers: { Cookie: adminCookie },
  });
  assert.equal(archivesRes.status, 200);
  assert.equal(archivesRes.body.length, 1);

  // New sale creation
  const newSaleRes = await request('/api/admin/new', {
    method: 'POST',
    headers: { Cookie: adminCookie },
    body: { sale_id: catRes.body.sale.id, title: 'Nouvelle Vente' },
  });
  assert.equal(newSaleRes.status, 200);
  assert.equal(newSaleRes.body.sale.closed, false);

  console.log('All server tests passed successfully!');
  testServer.close();
}

runTests().catch((err) => {
  console.error('Server tests failed:', err);
  process.exit(1);
});
