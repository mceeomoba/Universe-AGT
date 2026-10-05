export class AgentHostClient{
 constructor(readonly base:string,private token:string){if(!base.startsWith('https://')&&!/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(base))throw Error('HTTPS required')}
 async request(path:string,method='GET',body?:object){const r=await fetch(this.base+path,{method,headers:{Authorization:'Bearer '+this.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error(`Control plane request failed (${r.status})`);return r.json()}
 createProject(name:string){return this.request('/v1/projects','POST',{name})}
 createArtifact(input:{project_id:string;filename:string;checksum:string;size:number;version:string}){return this.request('/v1/artifacts','POST',input)}
 finalizeArtifact(id:string){return this.request('/v1/artifacts/'+encodeURIComponent(id)+'/finalize','POST')}
 rotate(){return this.request('/v1/credentials/rotate','POST')}
 services(){return this.request('/v1/services')}
 hosts(){return this.request('/v1/hosts')}
 deploy(input:{project_id:string;host_id:string;artifact_id:string;version:string;idempotency_key:string;mode?:'automatic'|'manual'}){return this.request('/v1/deployments','POST',{...input,mode:input.mode||'automatic'})}
 task(id:string){return this.request('/v1/tasks/'+encodeURIComponent(id))}
 approve(id:string){return this.request('/v1/tasks/'+encodeURIComponent(id)+'/approve','POST')}
 cancel(id:string){return this.request('/v1/tasks/'+encodeURIComponent(id)+'/cancel','POST')}
 events(after=0){return this.request('/v1/events?after='+after)}
}
