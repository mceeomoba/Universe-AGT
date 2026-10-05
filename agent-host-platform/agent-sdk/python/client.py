"""Language-neutral HTTPS client; does not connect to host IPs."""
import json, urllib.request, urllib.error
class AgentHostClient:
    def __init__(self, base, token):
        if not base.startswith('https://'): raise ValueError('HTTPS required')
        self.base, self.token = base.rstrip('/'), token
    def request(self, path, method='GET', data=None):
        req=urllib.request.Request(self.base+path, method=method, data=json.dumps(data).encode() if data is not None else None, headers={'Authorization':'Bearer '+self.token,'Content-Type':'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=30) as res: return json.load(res)
        except urllib.error.HTTPError as exc: raise RuntimeError('Control plane request failed (%s)' % exc.code) from None
    def deploy(self, **data):
        data.setdefault('mode','automatic')
        return self.request('/v1/deployments','POST',data)
    def task(self, task_id): return self.request('/v1/tasks/'+task_id)
    def hosts(self): return self.request('/v1/hosts')
    def events(self, after=0): return self.request('/v1/events?after='+str(after))
