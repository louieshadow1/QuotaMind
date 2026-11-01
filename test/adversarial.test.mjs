import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { startServer } from '../server.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-board-adversarial-'));
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ providers: { codex: {enabled:false,liveEnabled:false}, opencodeGo:{enabled:false}, deepseek:{enabled:false}, deepseekPlatform:{enabled:false}, relays:[] } }));
  const app = await startServer({ dataDir:dir, env:{PORT:'0',QUOTA_BOARD_DISABLE_ARCHIVER:'1'} });
  t.after(async () => { await app.close(); await fs.rm(dir,{recursive:true,force:true}); });
  return {app,dir};
}
const post = (url, data) => fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});

test('跨来源、简单请求和伪造 Host 被拒绝，同源及无 Origin 的 JSON 客户端可用', async (t) => {
  const {app} = await fixture(t);
  const target=app.url+'/api/settings';
  const cross = await fetch(target,{method:'POST',headers:{origin:'https://attacker.example','content-type':'text/plain'},body:'{"title":"attacked"}'});
  assert.equal(cross.status,403);
  const simple = await fetch(target,{method:'POST',headers:{'content-type':'text/plain'},body:'{"title":"attacked"}'});
  assert.equal(simple.status,415);
  const forgedSite = await fetch(target,{method:'POST',headers:{'sec-fetch-site':'cross-site','content-type':'application/json'},body:'{"title":"attacked"}'});
  assert.equal(forgedSite.status,403);
  const local = await fetch(target,{method:'POST',headers:{origin:app.url,'content-type':'application/json'},body:'{"title":"allowed"}'});
  assert.equal(local.status,200);
  assert.equal((await post(target,{title:'CLI'})).status,200);
  assert.equal((await (await fetch(app.url+'/api/config')).json()).settings.title,'CLI');
  const badHost=await new Promise((resolve,reject)=>{const r=http.get(app.url+'/api/health',{headers:{Host:'attacker.example'}},v=>{v.resume(); resolve(v.statusCode)});r.on('error',reject)});
  assert.equal(badHost,403);
});

test('非法请求目标返回 400，服务仍可响应', async (t) => {
  const {app}=await fixture(t);
  const status=await new Promise((resolve,reject)=>{const r=http.request({hostname:'127.0.0.1',port:app.port,path:'http://[',headers:{Host:`127.0.0.1:${app.port}`}},v=>{v.resume();resolve(v.statusCode)});r.on('error',reject);r.end()});
  assert.equal(status,400);
  assert.equal((await fetch(app.url+'/api/health')).status,200);
});

test('并发导入全部落盘且保留不同日期', async (t) => {
  const {app,dir}=await fixture(t);
  const responses=await Promise.all(Array.from({length:12},(_,i)=>post(app.url+'/api/daily/import',{channel:'deepseek',data:`2026-07-${String(i+1).padStart(2,'0')},${100+i},0.1`})));
  assert.deepEqual(responses.map(r=>r.status),Array(12).fill(200));
  const saved=JSON.parse(await fs.readFile(path.join(dir,'daily-history.json'),'utf8'));
  for(let i=0;i<12;i++) assert.equal(saved.days[`2026-07-${String(i+1).padStart(2,'0')}`].deepseekTokens,100+i);
});

test('并发添加站点后配置和对应令牌均完整', async (t) => {
  const {app,dir}=await fixture(t);
  const responses=await Promise.all(Array.from({length:12},(_,i)=>post(app.url+'/api/relays',{name:`test-${i}`,type:'newapi-token',baseUrl:'http://127.0.0.1:9',token:`FAKE-TOKEN-${i}`})));
  assert.deepEqual(responses.map(r=>r.status),Array(12).fill(201));
  const config=JSON.parse(await fs.readFile(path.join(dir,'config.json'),'utf8'));
  const secrets=JSON.parse(await fs.readFile(path.join(dir,'secrets.json'),'utf8'));
  assert.equal(config.providers.relays.length,12);
  for (const relay of config.providers.relays) assert.equal(secrets[relay.tokenRef],`FAKE-TOKEN-${relay.name.slice(5)}`);
});

test('损坏的历史不被覆盖且导入返回失败', async (t) => {
  const {app,dir}=await fixture(t); const file=path.join(dir,'daily-history.json');
  await fs.writeFile(file,'{broken');
  const result=await post(app.url+'/api/daily/import',{channel:'deepseek',data:'2026-07-01,100,0.1'});
  assert.equal(result.status,500);
  assert.equal(await fs.readFile(file,'utf8'),'{broken');
});
