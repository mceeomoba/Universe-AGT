import test from'node:test';import assert from'node:assert/strict';import pg from'pg';import{randomUUID}from'node:crypto';import{digest,mint,permissions}from'../control-plane/authentication/auth.js';import{Store}from'../control-plane/api/store.js';
const db=process.env.TEST_DATABASE_URL;
test('credential functions reject missing binding and scope escalation; RLS cannot cross tenants',{skip:!db},async()=>{const pool=new pg.Pool({connectionString:db}),tenant=randomUUID(),other=randomUUID(),subject=randomUUID(),agent=randomUUID();try{
 await pool.query('INSERT INTO universe.tenants(id,name)VALUES($1,$2),($3,$4)',[tenant,'security',other,'other']);await pool.query('INSERT INTO universe.agents(id,tenant_id,name,type)VALUES($1,$2,$3,$4)',[agent,tenant,'qa-agent','custom-agent']);
 const c=(await pool.query("INSERT INTO universe.credentials(tenant_id,subject_id,kind,token_hash,scopes,expires_at)VALUES($1,$2,'operator',$3,$4,now()+interval '1 hour')RETURNING id",[tenant,subject,digest(mint()),['approve','read_status']])).rows[0].id;
 const store=new Store(pool),p={credential_id:c,tenant_id:tenant,subject_id:subject,kind:'operator' as const,scopes:['approve','read_status']};
 await assert.rejects(store.tx(p,q=>q.query('SELECT universe.issue_credential($1,$2,$3,$4,$5,$6)',[tenant,agent,'agent',digest(mint()),['deploy'],1])));
 await assert.rejects(store.tx({...p,credential_id:randomUUID()},q=>q.query('SELECT universe.issue_credential($1,$2,$3,$4,$5,$6)',[tenant,agent,'agent',digest(mint()),['read_status'],1])));
 await assert.rejects(store.tx(p,q=>q.query('SELECT universe.rotate_credential($1,$2,$3)',[tenant,randomUUID(),digest(mint())])));
 await assert.rejects(store.tx(p,q=>q.query('INSERT INTO universe.projects(tenant_id,name,owner)VALUES($1,$2,$3)',[other,'forbidden',subject])));
 assert.equal((await store.tx(p,q=>q.query('SELECT * FROM universe.agents WHERE tenant_id=$1',[other]))).rowCount,0);
 const generated=await store.tx(p,q=>q.query('SELECT universe.issue_credential($1,$2,$3,$4,$5,$6)',[tenant,agent,'agent',digest(mint()),['read_status'],1]));assert.ok(generated.rows[0].issue_credential);
 }finally{await pool.end()}});
