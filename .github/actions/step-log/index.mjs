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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
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
async function githubApi(path) {
  return request(`https://api.github.com/repos/${repositoryName}${path}`, {
    headers: {
      accept: 'application/vnd.github.v3+json',
      authorization: `Bearer ${apiToken}`,
      'user-agent': 'repo-cassette-step-log-carrier',
    },
  });
}
function hexType(response) {
  return Buffer.from(response?.headers?.['content-type'] || '', 'latin1').toString('hex');
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
  if (!jobId) await sleep(250);
}
if (!jobId) throw new Error('could not discover REST job id');
console.log(`jobId=${jobId}`);

let target;
for (let attempt = 0; attempt < 80 && !target; attempt++) {
  const response = await request(`https://github.com/${repositoryName}/actions/runs/${runId}/job/${jobId}`, {
    headers: {'user-agent': 'repo-cassette-step-log-carrier'},
  });
  const html = response.body.toString();
  for (const match of html.matchAll(/<check-step\s+([\s\S]*?)>/g)) {
    const attributes = match[1];
    const name = attributes.match(/data-name="([^"]*)"/)?.[1];
    if (name !== 'Carrier target') continue;
    const number = attributes.match(/data-number="(\d+)"/)?.[1];
    const backendId = attributes.match(/data-external-id="([0-9a-f-]{36})"/)?.[1];
    if (number && backendId) target = {number: Number(number), backendId};
  }
  if (!target) await sleep(250);
}
if (!target) throw new Error('could not discover carrier step backend id');
console.log(`target=${JSON.stringify(target)}`);

const identity = {
  workflow_run_backend_id: workflowRunBackendId,
  workflow_job_run_backend_id: workflowJobRunBackendId,
  step_backend_id: target.backendId,
};
const signedResponse = await postReceiver('GetStepLogsSignedBlobURL', identity);
if (signedResponse.status !== 200) throw new Error(`GetStepLogsSignedBlobURL ${signedResponse.status}: ${signedResponse.body}`);
const signed = JSON.parse(signedResponse.body);
const signedUrl = signed.logs_url;
if (!signedUrl) throw new Error('no logs_url');

const repository = `${repositoryName}/actions/jobs/${jobId}/steps/${target.number}/logs`;
const expected = Buffer.from(JSON.stringify({
  full_name: repository,
  owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
  description: 'Repo Cassette carrier',
  stargazers_count: 0,
}));

const direct = await request(signedUrl, {
  method: 'PUT',
  headers: {
    'x-ms-version': '2023-11-03',
    'x-ms-blob-type': 'BlockBlob',
    'content-type': 'application/json\x85',
    'content-length': String(expected.length),
  },
}, expected);
if (direct.status !== 201) throw new Error(`direct upload ${direct.status}: ${direct.body.toString().slice(0,300)}`);

const metadata = await postReceiver('CreateStepLogsMetadata', {
  ...identity,
  uploaded_at: new Date().toISOString(),
  line_count: 1,
});
console.log('CARRIER', JSON.stringify({
  repository,
  jobId,
  stepNumber: target.number,
  stepBackendId: target.backendId,
  expectedBytes: expected.length,
  signedPermissions: new URL(signedUrl).searchParams.get('sp'),
  directStatus: direct.status,
  metadataStatus: metadata.status,
  metadataBody: metadata.body.toString().slice(0,200),
}));

for (let attempt = 0; attempt < 20; attempt++) {
  const response = await githubApi(`/actions/jobs/${jobId}/steps/${target.number}/logs`);
  if (response.status === 302) {
    const location = response.headers.location;
    const final = await request(location);
    console.log('CARRIER-HIT', JSON.stringify({
      repository,
      redirectStatus: response.status,
      rsct: new URL(location).searchParams.get('rsct'),
      finalStatus: final.status,
      finalTypeHex: hexType(final),
      bodyMatch: final.body.equals(expected),
      finalType: final.headers['content-type'],
    }));
    process.exit(0);
  }
  await sleep(1000);
}
const last = await githubApi(`/actions/jobs/${jobId}/steps/${target.number}/logs`);
console.log('CARRIER-MISS', JSON.stringify({status: last.status, type: last.headers['content-type'], body: last.body.toString().slice(0,200)}));
