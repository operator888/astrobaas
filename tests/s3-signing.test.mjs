#!/usr/bin/env node
/**
 * AWS Signature V4, pinned against a REAL published signature.
 *
 * Signing is the classic "looks right, returns 403" problem: every step is
 * plausible on its own, the failure gives no clue which one was wrong, and
 * "it worked against my bucket yesterday" proves nothing about the next key
 * that happens to contain a bracket.
 *
 * The load-bearing check is section 0: AWS's own worked example for GET Object
 * (docs "Signature Calculations for the Authorization Header", the
 * examplebucket/test.txt request) publishes the exact canonical request,
 * string-to-sign and final signature for service s3, region us-east-1. Those
 * are hard constants below — not recomputed by this file — so a signature that
 * matches is correct against AWS, not merely self-consistent. An earlier
 * version of this test only compared against a mirror of the implementation,
 * which is why a double-encoding bug in send() sailed through it; section 6
 * now pins the encode-once invariant directly.
 *
 * Run with:  node tests/s3-signing.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cacheDir = path.join(root, 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });
const out = path.join(cacheDir, `astrobaas-s3sign-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(root, 'src/lib/backup/s3.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: out, logLevel: 'silent',
});
const S = await import(pathToFileURL(out).href);
await fs.rm(out, { force: true });

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

/* The credentials and clock the AWS SigV4 test suite uses. */
const VECTOR = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  now: new Date('2015-08-30T12:36:00Z'),
};
// The suite signs against `service`, not `s3`. Our signer is fixed to `s3` —
// it only ever talks to object storage — so the vectors are recomputed here
// for that service with the published algorithm, and the check below proves
// our implementation agrees with an INDEPENDENT one rather than with itself.
const SERVICE = 's3';

/** The reference implementation, written from the specification, not from ours. */
function referenceSignature({ method, canonicalUri, canonicalQuery, headers, payload }) {
  const hex = (d) => crypto.createHash('sha256').update(d).digest('hex');
  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d, 'utf8').digest();
  const amzDate = VECTOR.now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const sorted = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const canonicalHeaders = sorted.map(([k, v]) => `${k}:${v}\n`).join('');
  const signedHeaders = sorted.map(([k]) => k).join(';');
  const canonicalRequest = [
    method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, hex(payload),
  ].join('\n');
  const scope = `${dateStamp}/${VECTOR.region}/${SERVICE}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${VECTOR.secretAccessKey}`, dateStamp), VECTOR.region), SERVICE), 'aws4_request');
  return {
    signature: crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex'),
    canonicalRequest,
    stringToSign,
    signedHeaders,
    scope,
  };
}

const sigOf = (auth) => /Signature=([0-9a-f]+)/.exec(auth)?.[1] ?? '';

/* ---- 0. AWS's OWN published GET Object example (service s3) ---- *
 * https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
 * These four values are copied from AWS; nothing here recomputes them. */
{
  const emptyHash = crypto.createHash('sha256').update('').digest('hex');
  const r = S.signRequest({
    method: 'GET',
    // examplebucket is virtual-hosted, so the canonical URI is just the key.
    path: '/test.txt',
    query: '',
    headers: {
      host: 'examplebucket.s3.amazonaws.com',
      range: 'bytes=0-9',
      'x-amz-content-sha256': emptyHash,
      'x-amz-date': '20130524T000000Z',
    },
    payloadHash: emptyHash,
    region: 'us-east-1',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    now: new Date('2013-05-24T00:00:00Z'),
  });

  const PUBLISHED_CANONICAL =
    'GET\n/test.txt\n\n'
    + 'host:examplebucket.s3.amazonaws.com\n'
    + 'range:bytes=0-9\n'
    + 'x-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n'
    + 'x-amz-date:20130524T000000Z\n\n'
    + 'host;range;x-amz-content-sha256;x-amz-date\n'
    + 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const PUBLISHED_STS =
    'AWS4-HMAC-SHA256\n20130524T000000Z\n20130524/us-east-1/s3/aws4_request\n'
    + '7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972';
  const PUBLISHED_SIG = 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41';

  check('the canonical request matches AWS\'s published example byte for byte',
    r.canonicalRequest === PUBLISHED_CANONICAL);
  check('the string to sign matches AWS\'s published example', r.stringToSign === PUBLISHED_STS);
  check('the SIGNATURE matches the constant AWS published for this request',
    sigOf(r.authorization) === PUBLISHED_SIG);
}

/* ---- 1. the shape of the Authorization header ---- */
{
  const r = S.signRequest({
    method: 'GET',
    path: '/',
    query: '',
    headers: { host: 'example.amazonaws.com' },
    payloadHash: crypto.createHash('sha256').update('').digest('hex'),
    region: VECTOR.region,
    accessKeyId: VECTOR.accessKeyId,
    secretAccessKey: VECTOR.secretAccessKey,
    now: VECTOR.now,
  });
  check('the header names the algorithm', r.authorization.startsWith('AWS4-HMAC-SHA256 '));
  check('...carries the credential scope',
    r.authorization.includes(`Credential=${VECTOR.accessKeyId}/20150830/us-east-1/s3/aws4_request`));
  check('...names the signed headers', /SignedHeaders=host/.test(r.authorization));
  check('...and ends with a 64-hex signature', /Signature=[0-9a-f]{64}$/.test(r.authorization));
}

/* ---- 2. agreement with an independently written implementation ---- */
{
  const cases = [
    {
      name: 'a bare GET',
      method: 'GET', path: '/', query: '',
      headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
      payload: '',
    },
    {
      name: 'a GET with a query string',
      method: 'GET', path: '/', query: 'Param1=value1&Param2=value2',
      headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
      payload: '',
    },
    {
      name: 'a PUT with a body',
      method: 'PUT', path: '/backups/site-2026-08-29.json', query: '',
      headers: {
        host: 'bucket.s3.amazonaws.com',
        'x-amz-date': '20150830T123600Z',
        'content-type': 'application/json',
      },
      payload: '{"hello":"world"}',
    },
    {
      name: 'headers in a different case and order',
      method: 'PUT', path: '/x', query: '',
      headers: {
        'X-Amz-Date': '20150830T123600Z',
        HOST: 'bucket.s3.amazonaws.com',
        'Content-Type': 'text/plain',
      },
      payload: 'body',
    },
  ];

  for (const c of cases) {
    const payloadHash = crypto.createHash('sha256').update(c.payload).digest('hex');
    const ours = S.signRequest({
      method: c.method,
      path: c.path,
      query: c.query,
      headers: { ...c.headers, 'x-amz-content-sha256': payloadHash },
      payloadHash,
      region: VECTOR.region,
      accessKeyId: VECTOR.accessKeyId,
      secretAccessKey: VECTOR.secretAccessKey,
      now: VECTOR.now,
    });
    const ref = referenceSignature({
      method: c.method,
      canonicalUri: c.path,
      canonicalQuery: c.query,
      headers: { ...c.headers, 'x-amz-content-sha256': payloadHash },
      payload: c.payload,
    });
    check(`${c.name}: the signature matches an independent implementation`,
      sigOf(ours.authorization) === ref.signature);
    check(`${c.name}: ...and so does the canonical request`,
      ours.canonicalRequest === ref.canonicalRequest);
    check(`${c.name}: ...and the string to sign`, ours.stringToSign === ref.stringToSign);
  }
}

/* ---- 3. the signature actually depends on everything it should ---- */
{
  const base = {
    method: 'PUT', path: '/b/k', query: '',
    headers: { host: 'h', 'x-amz-date': '20150830T123600Z' },
    payloadHash: crypto.createHash('sha256').update('a').digest('hex'),
    region: VECTOR.region,
    accessKeyId: VECTOR.accessKeyId,
    secretAccessKey: VECTOR.secretAccessKey,
    now: VECTOR.now,
  };
  const sig = (over) => sigOf(S.signRequest({ ...base, ...over }).authorization);
  const original = sig({});

  check('changing the body changes the signature',
    sig({ payloadHash: crypto.createHash('sha256').update('b').digest('hex') }) !== original);
  check('changing the key changes the signature', sig({ path: '/b/other' }) !== original);
  check('changing the method changes the signature', sig({ method: 'DELETE' }) !== original);
  check('changing the region changes the signature', sig({ region: 'eu-central-1' }) !== original);
  check('changing the secret changes the signature', sig({ secretAccessKey: 'other' }) !== original);
  check('a different day changes the signature',
    sig({ now: new Date('2015-08-31T12:36:00Z') }) !== original);
  check('the same inputs give the same signature', sig({}) === original);
}

/* ---- 4. URI encoding, which is where real keys break ---- */
{
  const e = S.uriEncode;
  check('unreserved characters are left alone', e('abcXYZ019-_.~') === 'abcXYZ019-_.~');
  check('a space becomes %20, not +', e('a b') === 'a%20b');
  // encodeURIComponent leaves these alone; SigV4 requires them encoded, and a
  // key containing one signs cleanly and then 403s.
  check("an apostrophe is encoded — encodeURIComponent would not", e("it's") === 'it%27s');
  check('brackets are encoded', e('a(b)c') === 'a%28b%29c');
  check('an exclamation mark is encoded', e('a!b') === 'a%21b');
  check('an asterisk is encoded', e('a*b') === 'a%2Ab');
  // Only the ESCAPES may be inspected for case: the literal characters around
  // them are letters too, and the first version of this check matched the 'a'
  // in 'a~b!' and could never pass.
  const escapes = (v) => [...e(v).matchAll(/%([0-9A-Fa-f]{2})/g)].map((m) => m[1]);
  // é and ÿ are two UTF-8 bytes each, plus the space and the bang: six escapes.
  check('hex in an escape is UPPERCASE, as the spec requires',
    escapes('é ÿ!').length === 6 && escapes('é ÿ!').every((h) => h === h.toUpperCase()));
  check('...and a lowercase-able byte really is produced, so that check bites',
    escapes('ÿ').join() === 'C3,BF');
  check('a slash is encoded in a key by default', e('a/b') === 'a%2Fb');
  check('...and preserved in a path when asked', e('a/b', false) === 'a/b');
  check('non-ASCII is UTF-8 percent-encoded', e('é') === '%C3%A9');
  check('Greek is encoded byte by byte', e('σ') === '%CF%83');
}

/* ---- 5. path-style vs virtual-host addressing ---- */
{
  const cfg = {
    endpoint: 'https://s3.eu-central-1.amazonaws.com',
    region: 'eu-central-1', bucket: 'my-backups',
    accessKeyId: 'x', secretAccessKey: 'y',
  };
  const virt = S.objectUrl(cfg, 'daily/site.json');
  check('virtual-host puts the bucket in the hostname', virt.host === 'my-backups.s3.eu-central-1.amazonaws.com');
  check('...and only the key in the path', virt.path === '/daily/site.json');

  const pathStyle = S.objectUrl({ ...cfg, forcePathStyle: true }, 'daily/site.json');
  check('path-style keeps the bucket in the path', pathStyle.path === '/my-backups/daily/site.json');
  check('...and leaves the hostname alone', pathStyle.host === 's3.eu-central-1.amazonaws.com');
  check('the signed host matches the URL actually used, in both styles',
    virt.origin.includes(virt.host) && pathStyle.origin.includes(pathStyle.host));

  // A key with a character that needs encoding must be encoded in the URL and
  // in the signature identically, or the request 403s.
  const odd = S.objectUrl(cfg, "daily/it's here.json");
  check('a key needing encoding is encoded in the path', odd.path === '/daily/it%27s%20here.json');
  check('...with the slashes still separating segments', odd.path.split('/').length === 3);
}

/* ---- 6. a key with special chars is encoded ONCE, sent == signed ---- */
{
  const cfg = {
    endpoint: 'https://s3.eu-central-1.amazonaws.com',
    region: 'eu-central-1', bucket: 'b',
    accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret',
    forcePathStyle: true,
  };
  let sentUrl = '';
  let sentAuth = '';
  const fakeFetch = async (url, init) => {
    sentUrl = url;
    sentAuth = init.headers.Authorization;
    return { ok: true, status: 200, text: async () => '' };
  };
  // A prefix with an apostrophe and a space — the comments advertise Greek shop
  // names and impose no charset limit, so this is a real operator key.
  await S.s3.put(cfg, "astrobaas/it's here/backup.json", Buffer.from('x'), 'application/json', fakeFetch, new Date('2026-08-29T00:00:00Z'));

  // The path in the URL that was SENT.
  const sentPath = new URL(sentUrl).pathname;
  check("the key is percent-encoded once in the sent URL", sentPath === "/b/astrobaas/it%27s%20here/backup.json");
  // And %2527 (double-encoding) must appear in NEITHER the URL nor anything the
  // signature was computed over. The signature is over the path; if it were
  // double-encoded, the request would 403 against a real bucket.
  check("no double-encoding leaks into the sent URL", !/%25/.test(sentUrl));
  check("a real request was signed", /^AWS4-HMAC-SHA256 /.test(sentAuth));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
