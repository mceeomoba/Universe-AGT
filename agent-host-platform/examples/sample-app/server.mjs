import http from'node:http';http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',app:'sample-app'}))}).listen(8080,'0.0.0.0');
