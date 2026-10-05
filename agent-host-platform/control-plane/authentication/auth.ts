import {createHash,randomBytes} from 'node:crypto';
export type Principal={credential_id:string;tenant_id:string;subject_id:string;kind:'operator'|'agent'|'host';scopes:string[]};
export const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
export const mint=()=>`agt_${randomBytes(32).toString('base64url')}`;
export const permissions=['deploy','read_status','read_logs','restart','stop','start','remove','rollback','manage_domains','register_agent','register_host','manage_projects','manage_artifacts','approve','worker','rotate'] as const;
export function requireScope(p:Principal,scope:string){if(!p.scopes.includes(scope))throw Object.assign(new Error('Forbidden'),{statusCode:403})}
export function requireHost(p:Principal,id:string){requireScope(p,'worker');if(p.kind!=='host'||p.subject_id!==id)throw Object.assign(new Error('Forbidden'),{statusCode:403})}
