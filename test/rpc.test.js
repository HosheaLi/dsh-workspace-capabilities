/**
 * rpc.js 路由层的契约测试：注册重试、逐请求鉴权栅栏、协议校验。
 *
 * 这里不建真实 Cordis —— 测的是 `registerRpcSurface` 这个纯函数对载体（webServer /
 * connection）的用法，宿主契约由 `test/integration.test.js` 在真实运行时上覆盖。
 */

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { registerRpcSurface, RPC_PATH } from '../lib/rpc.js';

const logger = { warn: () => {} };

/** 载体替身：捕获注册的路由与事件监听，`register` 可被替换成抛错的实现。 */
function makeCtx({ connection, register } = {}) {
  const listeners = [];
  const routes = new Map();
  const webServer = {
    register: register ?? ((route) => {
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    }),
  };
  return {
    listeners,
    routes,
    ctx: {
      logger,
      on: (event, callback) => listeners.push({ event, callback }),
      get: (name) => {
        if (name === 'webServer') return webServer;
        if (name === 'connection') return connection;
        return undefined;
      },
    },
  };
}

/** 用假的 node:http req/res 驱动真实的路由处理器。 */
async function call(route, { method = 'POST', headers = {}, body = '{}' } = {}) {
  const req = Readable.from([Buffer.from(body)]);
  req.method = method;
  req.url = RPC_PATH;
  req.headers = headers;
  const captured = { status: undefined, body: undefined };
  await route.handler(req, {
    writeHead: (status) => {
      captured.status = status;
    },
    end: (text) => {
      captured.body = text;
    },
  });
  return captured;
}

test('路由注册失败后仍会重试：首次抛错必须挂 internal/service 监听', () => {
  let attempts = 0;
  const routes = new Map();
  const { ctx, listeners } = makeCtx({
    register: (route) => {
      attempts += 1;
      if (attempts === 1) throw new Error('webserver: duplicate exact route');
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
  });
  const dispose = registerRpcSurface({ ctx, methods: {}, logger });

  assert.equal(attempts, 1, '首次应尝试注册');
  const retry = listeners.filter((entry) => entry.event === 'internal/service');
  assert.equal(retry.length, 1, '注册失败必须留下重试机会，否则面板永久没有路由');
  retry[0].callback('webServer');
  assert.equal(attempts, 2, '载体就绪后必须重试');
  assert.ok(routes.has(RPC_PATH), '重试成功应真正挂上路由');

  dispose();
  assert.equal(routes.has(RPC_PATH), false, '卸载必须撤掉路由');
});

test('没有 Connection 时退化栅栏：非回环 Host / 跨站 Origin 一律 403', async () => {
  const { ctx, routes } = makeCtx();
  registerRpcSurface({ ctx, methods: { ping: async () => 'pong' }, logger });
  const route = routes.get(RPC_PATH);

  assert.equal((await call(route, { headers: { host: 'evil.example.com' } })).status, 403, '非回环 Host 必须拒绝');
  assert.equal((await call(route, { headers: {} })).status, 403, '缺 Host 必须拒绝');
  assert.equal(
    (await call(route, { headers: { host: '127.0.0.1:19387', origin: 'http://evil.example.com' } })).status,
    403,
    '跨站 Origin 必须拒绝',
  );

  const sameOrigin = await call(route, { headers: { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387', 'content-type': 'application/json' }, body: JSON.stringify({ method: 'ping' }) });
  assert.equal(sameOrigin.status, 200, '回环同源必须放行');
  assert.equal(JSON.parse(sameOrigin.body).value, 'pong');

  const noOrigin = await call(route, { headers: { host: 'localhost:19387', 'content-type': 'application/json' }, body: JSON.stringify({ method: 'ping' }) });
  assert.equal(noOrigin.status, 200, '回环无 Origin（同进程客户端）必须放行');
});

test('有 Connection 时逐请求过栅栏，而不是注册时判断一次', async () => {
  let checks = 0;
  const connection = {
    requestRejection: ({ headers }) => {
      checks += 1;
      return headers?.['x-test-auth'] === 'ok' ? undefined : 401;
    },
  };
  const { ctx, routes } = makeCtx({ connection });
  registerRpcSurface({ ctx, methods: { ping: async () => 'pong' }, logger });
  const route = routes.get(RPC_PATH);
  const base = { host: '127.0.0.1:19387', 'content-type': 'application/json' };
  const body = JSON.stringify({ method: 'ping' });

  assert.equal((await call(route, { headers: { ...base, 'x-test-auth': 'no' }, body })).status, 401);
  assert.equal((await call(route, { headers: { ...base, 'x-test-auth': 'ok' }, body })).status, 200, '带凭据的请求必须放行');
  assert.equal(checks, 2, '每次请求都要过栅栏（注册时判断一次会漏掉首屏/后续变更）');
});

test('协议校验：方法、content-type、未知方法、请求体上限', async () => {
  const { ctx, routes } = makeCtx();
  const methods = {
    ping: async () => 'pong',
    boom: async () => {
      throw new Error('业务错误');
    },
  };
  registerRpcSurface({ ctx, methods, logger });
  const route = routes.get(RPC_PATH);
  const json = { host: '127.0.0.1:19387', 'content-type': 'application/json' };

  assert.equal((await call(route, { method: 'GET', headers: json })).status, 405);
  assert.equal((await call(route, { headers: { host: '127.0.0.1:19387', 'content-type': 'text/plain' }, body: 'x' })).status, 415);
  assert.equal((await call(route, { headers: json, body: JSON.stringify({ method: 'nope' }) })).status, 400);
  assert.equal((await call(route, { headers: json, body: 'x'.repeat(70 * 1024) })).status, 413);

  // 方法体抛错走的是业务错误通道（200 + ok:false），不是 HTTP 错误码。
  const boom = await call(route, { headers: json, body: JSON.stringify({ method: 'boom' }) });
  assert.equal(boom.status, 200);
  assert.equal(JSON.parse(boom.body).ok, false);
  assert.match(JSON.parse(boom.body).error, /业务错误/);
});
