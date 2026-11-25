const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
function run(script, available, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-reminder-'));
  try {
    fs.writeFileSync(path.join(dir, 'op'), '#!/bin/sh\n[ "$1" = read ] && [ "$2" = --no-newline ] || exit 3\n[ "$OP_CACHE" = false ] && [ "$OP_BIOMETRIC_UNLOCK_ENABLED" = false ] || exit 4\n[ -z "$UNRELATED_PASSWORD" ] || exit 5\n' + (available ? "case \"$3\" in 'op://BLT Automation/Azure OpenAI - default/password') printf %s default-vault-fixture ;; 'op://BLT Automation/Microsoft Graph - BLT/username'|'op://BLT Automation/Microsoft Graph - BLT/password'|'op://BLT Automation/Resend - BLT/password'|'op://BLT Automation/Azure OpenAI - BLT/password') printf %s vault-fixture ;; *) exit 8 ;; esac" : 'echo secret-stderr-fixture >&2; exit 1'), {mode:0o700});
    return spawnSync(process.execPath, ['-e', script], {cwd:path.resolve(__dirname,'..'), encoding:'utf8', env:{PATH:dir+path.delimiter+process.env.PATH, HOME:dir, OP_SERVICE_ACCOUNT_TOKEN:'fake-token', UNRELATED_PASSWORD:'must-not-reach-op', BLT_GRAPH_CLIENT_ID:'client-fixture', BLT_GRAPH_TENANT_ID:'tenant-fixture', BLT_GRAPH_CLIENT_SECRET:'doppler-fixture', RESEND_API_KEY:'doppler-fixture', BLT_AZURE_OPENAI_API_KEY:'doppler-fixture', BLT_AZURE_OPENAI_ENDPOINT:'https://synthetic.invalid', BLT_AZURE_OPENAI_DEPLOYMENT:'synthetic', ...overrides}});
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
}
for (const available of [true,false]) {
  test('watch alert credential source '+available, () => {
    const r=run(`const {sendWatchAlert}=require('./scripts/send-watch-alert.cjs'); sendWatchAlert({text:'synthetic'},async(url,opts)=>{console.log(JSON.stringify({url,headers:opts.headers,body:opts.body}));return {ok:true};}).catch(()=>process.exit(2));`,available);
    assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).headers.Authorization,'Bearer '+(available?'vault-fixture':'doppler-fixture'));
    assert.match(r.stderr,new RegExp('account=Resend_-_BLT credential_source='+(available?'1password':'doppler')));
    assert.doesNotMatch(r.stderr,/vault-fixture|doppler-fixture|secret-stderr-fixture|fake-token/);
  });
  test('actual Graph send credential source '+available, () => {
    const r=run(`global.fetch=async(url,opts)=>{if(url.includes('oauth2')){console.log(opts.body);return {ok:true,json:async()=>({access_token:'synthetic-access'})};}return {ok:true};};require('./lib/send.js').sendEmail({to:'test@example.invalid',subject:'synthetic',html:'synthetic'}).catch(()=>process.exit(2));`,available);
    assert.equal(r.status,0,r.stderr);const body=new URLSearchParams(r.stdout.trim());
    assert.equal(body.get('client_secret'),available?'vault-fixture':'doppler-fixture');
    assert.equal(body.get('client_id'),available?'vault-fixture':'client-fixture');
    assert.match(r.stderr,new RegExp('credential_source='+(available?'1password':'doppler')));
    assert.doesNotMatch(r.stderr,/vault-fixture|doppler-fixture|secret-stderr-fixture|fake-token/);
  });
  test('actual Azure request credential source '+available, () => {
    const r=run(`global.fetch=async(input,options)=>{console.log(new Headers(options?.headers||input.headers).get('api-key'));return new Response(JSON.stringify({id:'fixture',object:'chat.completion',created:0,model:'synthetic',choices:[{index:0,message:{role:'assistant',content:JSON.stringify({hasSOD:true,hasGAINSS:true})},finish_reason:'stop'}]}),{status:200,headers:{'content-type':'application/json'}});};require('./lib/classify.js').classifyDocs(['synthetic document']).catch(()=>process.exit(2));`,available);
    assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.trim(),available?'vault-fixture':'doppler-fixture');
    assert.match(r.stderr,new RegExp('credential_source='+(available?'1password':'doppler')));
    assert.doesNotMatch(r.stderr,/vault-fixture|doppler-fixture|secret-stderr-fixture|fake-token/);
  });

  test('generic Azure account retains its own vault identity '+available, () => {
    const r=run(`global.fetch=async(input,options)=>{console.log(new Headers(options?.headers||input.headers).get('api-key'));return new Response(JSON.stringify({id:'fixture',object:'chat.completion',created:0,model:'synthetic',choices:[{index:0,message:{role:'assistant',content:JSON.stringify({hasSOD:true,hasGAINSS:true})},finish_reason:'stop'}]}),{status:200,headers:{'content-type':'application/json'}});};require('./lib/classify.js').classifyDocs(['synthetic document']).catch(()=>process.exit(2));`,available,{BLT_AZURE_OPENAI_API_KEY:'',AZURE_OPENAI_API_KEY:'generic-doppler-fixture'});
    assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.trim(),available?'default-vault-fixture':'generic-doppler-fixture');
    assert.match(r.stderr,new RegExp('account=Azure_OpenAI_-_default credential_source='+(available?'1password':'doppler')));
    assert.doesNotMatch(r.stderr,/vault-fixture|doppler-fixture|secret-stderr-fixture|fake-token/);
  });

}
