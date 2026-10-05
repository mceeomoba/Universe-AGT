import pg from 'pg';import type {Principal} from '../authentication/auth.js';
export class Store{
 constructor(public pool:pg.Pool){}
 async tx<T>(p:Principal,fn:(q:pg.PoolClient)=>Promise<T>):Promise<T>{const q=await this.pool.connect();try{await q.query('BEGIN');await q.query('SET LOCAL ROLE universe_api');await q.query("SELECT set_config('universe.tenant_id',$1,true)",[p.tenant_id]);await q.query("SELECT set_config('universe.credential_id',$1,true)",[p.credential_id]);const result=await fn(q);await q.query('COMMIT');return result}catch(e){await q.query('ROLLBACK');throw e}finally{q.release()}}
 async authenticate(hash:string):Promise<Principal|undefined>{return(await this.pool.query('SELECT * FROM universe.authenticate($1)',[hash])).rows[0]}
}
export async function event(q:pg.PoolClient,p:Principal,type:string,resource:string,data:object={}){await q.query('INSERT INTO universe.events(tenant_id,actor_id,type,resource_id,data) VALUES($1,$2,$3,$4,$5)',[p.tenant_id,p.subject_id,type,resource,data])}
