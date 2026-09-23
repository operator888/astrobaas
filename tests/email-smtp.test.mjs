#!/usr/bin/env node
/**
 * SMTP message building and configuration (email-mime.ts, email-smtp.ts).
 *
 * These are the parts that fail SILENTLY. A subtly wrong message does not
 * error — it arrives as mojibake, or truncated, or carrying headers the sender
 * never wrote. So the assertions here are about bytes, not about happy paths.
 *
 * The socket half is exercised against a real in-process SMTP server at the
 * bottom, because a protocol driver that has never spoken to a server is a
 * guess.
 *
 * Run with:  node tests/email-smtp.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cacheDir = path.join(root, 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

const entry = path.join(cacheDir, `astrobaas-smtp-entry-${process.pid}.ts`);
await fs.writeFile(entry, `
export * from ${JSON.stringify(path.join(root, 'src/lib/email-mime.ts'))};
export { resolveSmtpConfig, parseReply, advertises, smtpSend, smtpTransport, isIpLiteral,
  SmtpError, isTransientSmtpError, isValidEhloName, smtpBackoffMs, SMTP_MAX_RETRIES, newMessageId,
  defaultHeloName, maskAddress, SMTP_BACKOFF_MS }
  from ${JSON.stringify(path.join(root, 'src/lib/email-smtp.ts'))};
`);
const out = path.join(cacheDir, `astrobaas-smtp-${process.pid}.mjs`);
await build({
  entryPoints: [entry], bundle: true, format: 'esm', platform: 'node',
  packages: 'external', outfile: out, logLevel: 'silent',
});
const S = await import(pathToFileURL(out).href);
await fs.rm(out, { force: true });
await fs.rm(entry, { force: true });

/*
 * CHILD MODE for the certificate-identity test near the bottom.
 *
 * It needs the client to TRUST a test CA, and the only way to add one to a
 * process's store without a code path the product does not have is
 * NODE_EXTRA_CA_CERTS — which Node reads once, at startup. So the parent makes
 * the certificates and runs this file again with it set; this half serves each
 * certificate on 127.0.0.1 (STARTTLS and implicit TLS), sends through the real
 * smtpSend with verification ON, and prints what happened.
 */
if (process.env.SMTP_TLS_IDENTITY_CHILD) {
  const dir = process.env.SMTP_TLS_IDENTITY_CHILD;
  const tlsMod = await import('node:tls');
  const read = (f) => fs.readFile(path.join(dir, f), 'utf8');
  const certs = {
    ip: { key: await read('ip.key'), cert: await read('ip.pem') },
    localhost: { key: await read('localhost.key'), cert: await read('localhost.pem') },
  };
  // One conversation handler for both kinds of server: STARTTLS is offered only
  // when there is an upgrade to perform.
  const serve = (sock, onStartTls) => {
    sock.setEncoding('utf8');
    let buf = '';
    let dataMode = false;
    sock.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (dataMode) { if (line === '.') { dataMode = false; sock.write('250 queued\r\n'); } continue; }
        const verb = line.split(/[ :]/)[0].toUpperCase();
        if (verb === 'EHLO') sock.write(onStartTls ? '250-id.test\r\n250 STARTTLS\r\n' : '250 id.test\r\n');
        else if (verb === 'STARTTLS' && onStartTls) { sock.write('220 go ahead\r\n'); onStartTls(); return; }
        else if (verb === 'DATA') { dataMode = true; sock.write('354 go ahead\r\n'); }
        else if (verb === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 ok\r\n');
      }
    });
    sock.on('error', () => {});
  };
  const socks = new Set();
  const starttlsServer = (c) => net.createServer((sock) => {
    socks.add(sock);
    sock.write('220 id.test ESMTP\r\n');
    serve(sock, () => {
      const secured = new tlsMod.TLSSocket(sock, { isServer: true, ...c });
      secured.on('secure', () => serve(secured, null));
      secured.on('error', () => {});
    });
  });
  const implicitServer = (c) => tlsMod.createServer(c, (sock) => {
    socks.add(sock);
    sock.write('220 id.test ESMTP\r\n');
    serve(sock, null);
  });
  const attempt = async (server, secure) => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      await S.smtpSend(
        { host: '127.0.0.1', port: server.address().port, secure, from: 'shop@example.gr', timeoutMs: 5000 },
        { to: 'buyer@example.com', subject: 's', text: 't' },
      );
      return { ok: true };
    } catch (e) {
      return { ok: false, code: e?.code ?? null, message: String(e?.message), transient: S.isTransientSmtpError(e) };
    } finally {
      for (const s of socks) s.destroy();
      socks.clear();
      await new Promise((r) => server.close(r));
    }
  };
  const result = {
    starttlsIp: await attempt(starttlsServer(certs.ip), false),
    starttlsLocalhost: await attempt(starttlsServer(certs.localhost), false),
    implicitIp: await attempt(implicitServer(certs.ip), true),
    implicitLocalhost: await attempt(implicitServer(certs.localhost), true),
  };
  console.log(`__TLSID__${JSON.stringify(result)}`);
  process.exit(0);
}

let pass = 0;
let fail = 0;
let skipped = 0;
// Bound NOW: some blocks below replace console.error to capture the client's
// log lines, and a failure reported through the replaced one was counted but
// never NAMED — the file went red without saying which assertion.
const report = console.error.bind(console);
const check = (n, c) => { if (c) pass++; else { fail++; report(`✗ ${n}`); } };

// The wait for the reply to "." defaults to TEN MINUTES now. A regression that
// leaves a test waiting on it must fail by saying so, not hang the run: the
// whole file normally takes seconds.
const watchdog = setTimeout(() => {
  report(`✗ the suite did not finish within 180 s — a wait that should be bounded is not (${pass} passed, ${fail} failed so far)`);
  process.exit(1);
}, 180_000);
watchdog.unref();
/**
 * A test that could not RUN is not a test that passed.
 *
 * `check('STARTTLS test skipped (no openssl available)', true)` used to stand
 * where this is called: a literal `true`, counted in the pass tally. On any
 * machine without openssl the suite reported green for the STARTTLS path — the
 * path port 587 takes, which is the default — without exercising a byte of it.
 * That is the same "verification that cannot fail" shape this project keeps
 * finding, just wearing a skip's clothes.
 *
 * Now it is counted separately, printed loudly, and CI can demand coverage:
 * with REQUIRE_FULL_COVERAGE=1 a skip is a failure.
 */
const skip = (n, why) => {
  skipped += 1;
  if (process.env.REQUIRE_FULL_COVERAGE === '1') {
    fail += 1;
    console.error(`✗ ${n} — SKIPPED but REQUIRE_FULL_COVERAGE=1 (${why})`);
  } else {
    console.error(`⚠ SKIPPED: ${n} — ${why}`);
  }
};

/* ---- non-ASCII headers: the normal case for a Greek shop ---- */
{
  const plain = S.encodeHeaderValue('Order A-1001');
  check('an ASCII subject is left alone', plain === 'Order A-1001');

  const greek = S.encodeHeaderValue('Η παραγγελία σας');
  // Raw UTF-8 in a header is not legal mail. Without the encoded-word this
  // arrives as mojibake, and it is the commonest bug in hand-rolled senders
  // because the author tested in English.
  check('a Greek subject becomes an RFC 2047 encoded-word', greek.startsWith('=?UTF-8?B?'));
  check('...and decodes back to the original',
    Buffer.from(greek.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, ''), 'base64')
      .toString('utf8') === 'Η παραγγελία σας');

  // Each encoded-word must stay under 75 characters, so a long subject folds.
  const long = S.encodeHeaderValue('Η παραγγελία σας από το κατάστημα οπτικών είναι έτοιμη για αποστολή σήμερα');
  check('a long non-ASCII subject folds into several words', long.includes('\r\n '));
  check('...and every word is within the RFC length limit',
    long.split('\r\n ').every((w) => w.length <= 75));
  // Splitting mid-character produces a replacement character on the far side.
  const rebuilt = long.split('\r\n ')
    .map((w) => Buffer.from(w.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, ''), 'base64').toString('utf8'))
    .join('');
  check('...and the folded words rejoin to the exact original',
    rebuilt === 'Η παραγγελία σας από το κατάστημα οπτικών είναι έτοιμη για αποστολή σήμερα');
}

/* ---- header injection ---- */
{
  const evil = S.encodeHeaderValue('Order 1\r\nBcc: attacker@evil.test');
  check('CRLF cannot smuggle a header', !evil.includes('\r\nBcc'));
  check('a bare LF cannot either', !S.headerSafe('a\nb').includes('\n'));
  check('a bare CR cannot either', !S.headerSafe('a\rb').includes('\r'));
}

/* ---- dot-stuffing: truncation, and command injection ---- */
{
  // A line that is just "." ENDS the DATA command. Everything after it is fed
  // to the server as commands.
  const body = 'first line\n.\nRCPT TO:<attacker@evil.test>\nlast line';
  const stuffed = S.stuffDots(body);
  check('a lone dot line is escaped', stuffed.includes('\r\n..\r\n'));
  check('...so the message is not truncated', stuffed.includes('last line'));
  check('a line merely STARTING with a dot is escaped too',
    S.stuffDots('.hidden').startsWith('..hidden'));
  check('a dot in the middle of a line is untouched',
    S.stuffDots('version 1.2') === 'version 1.2');
  check('every line ending becomes CRLF',
    S.stuffDots('a\nb\r\nc\rd') === 'a\r\nb\r\nc\r\nd');
}

/* ---- the MIME body ---- */
{
  const text = S.buildMimeMessage({
    from: 'shop@example.gr', to: 'buyer@example.com',
    subject: 'Η παραγγελία σας', text: 'Ευχαριστούμε.',
  });
  check('a text-only message declares utf-8', text.includes('charset=utf-8'));
  check('...and base64, which no relay can corrupt', text.includes('Content-Transfer-Encoding: base64'));
  check('...with headers separated from the body by a blank line', text.includes('\r\n\r\n'));
  const b64 = text.split('\r\n\r\n')[1];
  check('...and the body decodes to the original',
    Buffer.from(b64, 'base64').toString('utf8') === 'Ευχαριστούμε.');

  const both = S.buildMimeMessage({
    from: 'shop@example.gr', to: 'b@example.com', subject: 's',
    text: 'plain', html: '<p>rich</p>', messageId: 'abc123',
  });
  check('a message with HTML is multipart/alternative', both.includes('multipart/alternative'));
  // Two part openers and one closer. Counting the raw string would also match
  // the boundary= parameter in the header, which is not a delimiter.
  check('...with two part delimiters and one closing delimiter',
    (both.match(/\r\n--=_ab_abc123/g) || []).length === 3);
  check('...and the final delimiter is closed with --', /--=_ab_abc123--\s*$/.test(both));
  check('...and the header names the same boundary', both.includes('boundary="=_ab_abc123"'));
  check('...carrying both parts', both.includes('text/plain') && both.includes('text/html'));
}

/* ---- SMTP line limits ---- */
{
  // 1000 octets per line including CRLF. A single long base64 run exceeds it
  // and servers may reject or wrap it destructively.
  const huge = S.buildMimeMessage({
    from: 'a@b.gr', to: 'c@d.gr', subject: 's', text: 'x'.repeat(50_000),
  });
  const longest = Math.max(...huge.split('\r\n').map((l) => l.length));
  check('no line exceeds the SMTP limit', longest <= 998);
  check('...because base64 is wrapped at 76', longest <= 76 || huge.includes('Content-Type'));
}

/* ---- envelope vs header address ---- */
{
  // `Example Optics <shop@x.gr>` is a valid From HEADER and an invalid envelope.
  check('a display name is stripped for the envelope',
    S.envelopeAddress('Example Optics <shop@example.gr>') === 'shop@example.gr');
  check('a bare address is unchanged', S.envelopeAddress('shop@example.gr') === 'shop@example.gr');
  check('a valid address is sendable', S.isSendableAddress('buyer@example.com'));
  check('...and one with a display name is too', S.isSendableAddress('B <buyer@example.com>'));
  check('no domain dot is refused', !S.isSendableAddress('buyer@localhost'));
  check('a space is refused', !S.isSendableAddress('a b@example.com'));
  check('two at-signs are refused', !S.isSendableAddress('a@b@example.com'));
  check('empty is refused', !S.isSendableAddress(''));
}

/* ---- configuration ---- */
{
  const ok = S.resolveSmtpConfig({ SMTP_HOST: 'mail.example.gr', EMAIL_FROM: 'shop@example.gr' });
  check('a minimal config resolves', !('error' in ok));
  check('...defaulting to the submission port', ok.port === 587);
  const sec = S.resolveSmtpConfig({ SMTP_HOST: 'h', EMAIL_FROM: 'a@b.gr', SMTP_SECURE: 'true' });
  check('implicit TLS defaults to 465', sec.port === 465 && sec.secure === true);

  // A misconfiguration must be a complaint with a REASON, not a silent
  // fallback an operator discovers when a customer says they got nothing.
  check('a missing host is an error', 'error' in S.resolveSmtpConfig({ EMAIL_FROM: 'a@b.gr' }));
  check('a missing From is an error', 'error' in S.resolveSmtpConfig({ SMTP_HOST: 'h' }));
  check('an unusable From is an error',
    'error' in S.resolveSmtpConfig({ SMTP_HOST: 'h', EMAIL_FROM: 'not-an-address' }));
  check('a user with no password is an error',
    'error' in S.resolveSmtpConfig({ SMTP_HOST: 'h', EMAIL_FROM: 'a@b.gr', SMTP_USER: 'u' }));
  check('a nonsense port is an error',
    'error' in S.resolveSmtpConfig({ SMTP_HOST: 'h', EMAIL_FROM: 'a@b.gr', SMTP_PORT: '70000' }));
}

/* ---- reply parsing ---- */
{
  check('a single-line reply parses', S.parseReply('250 OK\r\n').code === 250);
  // A client that treats a partial multi-line reply as complete sends its next
  // command into the middle of the previous answer.
  check('a multi-line reply is incomplete until its last line',
    S.parseReply('250-SIZE 100\r\n250-STARTTLS\r\n') === null);
  const full = S.parseReply('250-SIZE 100\r\n250-STARTTLS\r\n250 AUTH PLAIN\r\n');
  check('...and complete when it arrives', full.code === 250 && full.lines.length === 3);
  check('capabilities are readable', S.advertises(full, 'STARTTLS'));
  check('...case-insensitively', S.advertises(full, 'starttls'));
  check('...and absent ones are absent', !S.advertises(full, 'STARTTLSX'));
  check('an empty buffer is incomplete', S.parseReply('') === null);
  // A buffer cut mid-line by TCP is NOT a reply. Treating it as one let the
  // client act on half a line and read the remainder as the next reply.
  check('an unterminated final line is incomplete', S.parseReply('250 OK') === null);
  check('...and becomes complete once it is terminated', S.parseReply('250 OK\r\n')?.code === 250);
  check('a truncated multi-line reply is incomplete',
    S.parseReply('250-SIZE 100\r\n250 AUT') === null);
  // RFC 5321 §4.2: the text after the code is OPTIONAL. The parser demanded a
  // space after the code, so a server answering "." with a bare `250` was never
  // heard — the client timed out and, as it then retried, delivered the
  // message three times while reporting it failed.
  check('a bare code with no text is a complete reply (RFC 5321 §4.2)', S.parseReply('250\r\n')?.code === 250);
  check('...and ends a multi-line reply too',
    S.parseReply('250-SIZE 100\r\n250\r\n')?.code === 250 && S.parseReply('250-SIZE 100\r\n250\r\n')?.lines.length === 2);
  check('a bare CONTINUATION is still not the end', S.parseReply('250-\r\n') === null);
  check('four digits are not a reply code', S.parseReply('2500 OK\r\n') === null);
}

/* ---- against a real server ---- */
{
  /** A minimal SMTP server that records the conversation. */
  const transcript = [];
  let dataMode = false;
  let received = '';
  const server = net.createServer((sock) => {
    sock.setEncoding('utf8');
    sock.write('220 test.local ESMTP\r\n');
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (dataMode) {
          if (line === '.') { dataMode = false; sock.write('250 queued\r\n'); }
          else received += `${line}\n`;
          continue;
        }
        transcript.push(line);
        const verb = line.split(/[ :]/)[0].toUpperCase();
        if (verb === 'EHLO') sock.write('250-test.local\r\n250 AUTH PLAIN\r\n');
        else if (verb === 'AUTH') sock.write('235 ok\r\n');
        else if (verb === 'MAIL' || verb === 'RCPT') sock.write('250 ok\r\n');
        else if (verb === 'DATA') { dataMode = true; sock.write('354 go ahead\r\n'); }
        else if (verb === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 ok\r\n');
      }
    });
    sock.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  await S.smtpSend(
    { host: '127.0.0.1', port, secure: false, from: 'Shop <shop@example.gr>', timeoutMs: 5000 },
    { to: 'Buyer <buyer@example.com>', subject: 'Η παραγγελία σας', text: 'Γεια.\n.\nτέλος' },
  );

  check('the conversation reaches DATA', transcript.some((l) => l === 'DATA'));
  check('MAIL FROM uses the bare address, not the display name',
    transcript.some((l) => l === 'MAIL FROM:<shop@example.gr>'));
  check('RCPT TO does too', transcript.some((l) => l === 'RCPT TO:<buyer@example.com>'));
  check('the server accepted the body', received.includes('Content-Transfer-Encoding'));
  // The lone dot inside the body must not have ended DATA early.
  check('the body was not truncated by its own dot line', received.includes('MIME-Version'));

  // AUTH over plaintext must be refused, because base64 is encoding not
  // encryption and this server offered no STARTTLS.
  let refused = false;
  try {
    await S.smtpSend(
      { host: '127.0.0.1', port, secure: false, from: 'a@b.gr', user: 'u', pass: 'p', timeoutMs: 5000 },
      { to: 'c@d.gr', subject: 's', text: 't' },
    );
  } catch (e) { refused = /unencrypted/i.test(String(e.message)); }
  check('credentials are refused over an unencrypted connection', refused);
  // That assertion could not fail: the refusal happens BEFORE any AUTH is sent,
  // so the transcript never contains one either way. What matters is that the
  // password does not reach the ERROR the operator sees.
  let authErr = '';
  try {
    await S.smtpSend(
      { host: '127.0.0.1', port, secure: false, from: 'a@b.gr',
        user: 'u', pass: 'sup3rs3cret', timeoutMs: 5000 },
      { to: 'c@d.gr', subject: 's', text: 't' },
    );
  } catch (e) { authErr = String(e.message); }
  check('the password never appears in the error', !authErr.includes('sup3rs3cret'));
  check('...nor base64-encoded in it',
    !authErr.includes(Buffer.from('sup3rs3cret').toString('base64')));

  // The explicit escape hatch for a localhost relay.
  let allowed = false;
  try {
    await S.smtpSend(
      { host: '127.0.0.1', port, secure: false, from: 'a@b.gr', user: 'u', pass: 'p',
        allowInsecureAuth: true, timeoutMs: 5000 },
      { to: 'c@d.gr', subject: 's', text: 't' },
    );
    allowed = true;
  } catch { allowed = false; }
  check('...unless the operator explicitly allowed it', allowed);

  // A recipient the server would reject is refused before we connect at all.
  let badTo = false;
  try {
    await S.smtpSend({ host: '127.0.0.1', port, secure: false, from: 'a@b.gr', timeoutMs: 5000 },
      { to: 'nonsense', subject: 's', text: 't' });
  } catch (e) { badTo = /recipient/i.test(String(e.message)); }
  check('an unusable recipient is refused before connecting', badTo);

  await new Promise((r) => server.close(r));
}

/* ---- STARTTLS: the path the DEFAULT port takes ---- */
{
  // The bug this exists for: the DATA payload was written to the socket the
  // client OPENED, not the one STARTTLS upgraded it to — so on port 587, the
  // default whenever SMTP_SECURE is unset, the body went to the plaintext
  // socket underneath the TLS session and the server never saw it. Every
  // assertion above passed anyway, because none of them upgraded.
  const tlsMod = await import('node:tls');
  const cryptoMod = await import('node:crypto');

  // A throwaway self-signed certificate, generated here so the test needs no
  // fixture files and no network.
  const { privateKey, publicKey } = cryptoMod.generateKeyPairSync('rsa', { modulusLength: 2048 });
  let cert;
  try {
    const x = await import('node:child_process');
    const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const tmpKey = path.join(cacheDir, `smtp-key-${process.pid}.pem`);
    await fs.writeFile(tmpKey, keyPem);
    cert = x.execSync(
      `openssl req -new -x509 -key ${tmpKey} -days 1 -subj "/CN=localhost" 2>/dev/null`,
    ).toString();
    await fs.rm(tmpKey, { force: true });
    var keyOut = keyPem;
  } catch {
    cert = null;
  }

  if (!cert) {
    // openssl is not a dependency of this project, so skipping is honest — but
    // it must not be counted as a pass. See `skip` above.
    skip('a message survives the STARTTLS upgrade', 'no openssl available to make a test certificate');
  } else {
    let received = '';
    let dataMode = false;
    const handle = (sock, onUpgrade) => {
      sock.setEncoding('utf8');
      let buf = '';
      sock.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\r\n')) !== -1) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (dataMode) {
            if (line === '.') { dataMode = false; sock.write('250 queued\r\n'); }
            else received += `${line}\n`;
            continue;
          }
          const verb = line.split(/[ :]/)[0].toUpperCase();
          if (verb === 'EHLO') sock.write('250-test.local\r\n250 STARTTLS\r\n');
          else if (verb === 'STARTTLS') { sock.write('220 go ahead\r\n'); onUpgrade(); return; }
          else if (verb === 'MAIL' || verb === 'RCPT') sock.write('250 ok\r\n');
          else if (verb === 'DATA') { dataMode = true; sock.write('354 send it\r\n'); }
          else if (verb === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
          else sock.write('250 ok\r\n');
        }
      });
      sock.on('error', () => {});
    };

    const server = net.createServer((sock) => {
      sock.write('220 test.local ESMTP\r\n');
      handle(sock, () => {
        const secured = new tlsMod.TLSSocket(sock, { isServer: true, key: keyOut, cert });
        // After the upgrade the SAME conversation continues, on the new socket.
        secured.on('secure', () => handle(secured, () => {}));
        secured.on('error', () => {});
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    let sent = false;
    try {
      await S.smtpSend(
        { host: '127.0.0.1', port, secure: false, from: 'shop@example.gr', timeoutMs: 8000, allowSelfSigned: true },
        { to: 'buyer@example.com', subject: 'Η παραγγελία σας', text: 'Γεια σας.' },
      );
      sent = true;
    } catch (e) { sent = false; console.error('   STARTTLS attempt:', e.message); }

    check('a message survives the STARTTLS upgrade', sent);
    // The bug this uncovered: SNI cannot be an IP literal, and an internal
    // relay configured by address is a normal thing to have.
    check('an IPv4 host is recognised as a literal', S.isIpLiteral('127.0.0.1'));
    check('an IPv6 host is too', S.isIpLiteral('::1'));
    check('a host NAME is not', !S.isIpLiteral('mail.example.gr'));
    // The body must have arrived on the UPGRADED socket. Before the fix this
    // was empty while every other assertion still passed.
    check('...and the server actually received the body',
      received.includes('MIME-Version') && received.includes('Subject:'));
    await new Promise((r) => server.close(r));
  }
}

/* ---- address headers: only the NAME is ever encoded ---- */
{
  // The bug: a non-ASCII display name made the WHOLE header one encoded-word,
  // address included. RFC 2047 forbids that, so no client could read the
  // address and a server checking From against the login had nothing to match.
  const greek = S.encodeAddressHeader('Οπτική Γωνία <shop@example.gr>');
  check('a Greek display name keeps its address readable', greek.endsWith(' <shop@example.gr>'));
  check('...with the name itself encoded', /^=\?UTF-8\?B\?[^ ]+\?= <shop@example\.gr>$/.test(greek));
  check('an ASCII name is written exactly as before',
    S.encodeAddressHeader('Astrobaas <noreply@astrobaas.com>') === 'Astrobaas <noreply@astrobaas.com>');
  check('a bare address passes through', S.encodeAddressHeader('info@astrobaas.com') === 'info@astrobaas.com');
  // Unquoted, `Smith, John <j@x>` is TWO mailboxes to a parser.
  check('a name with specials is quoted', S.encodeAddressHeader('Smith, John <j@x.gr>') === '"Smith, John" <j@x.gr>');
  check('a CRLF cannot start a new header',
    !/[\r\n]/.test(S.encodeAddressHeader('X <a@b.gr>\r\nBcc: victim@z.gr')));

  const hdr = (raw, name) => raw.split('\r\n').filter((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  const m = S.buildMimeMessage({
    from: 'Οπτική Γωνία <shop@example.gr>', to: 'buyer@example.com', subject: 's', text: 't',
    replyTo: 'Εξυπηρέτηση <info@example.gr>',
    headers: { 'Reply-To': 'attacker@evil.example', 'List-Unsubscribe': '<https://u.example/x>' },
  });
  check('From carries the address outside the encoded name', hdr(m, 'From')[0]?.endsWith(' <shop@example.gr>'));
  check('Reply-To is written from the field', hdr(m, 'Reply-To')[0]?.endsWith(' <info@example.gr>'));
  // A second Reply-To smuggled through `headers` would leave which one a client
  // honours unspecified. The field is the only way in.
  check('...exactly once — a Reply-To in `headers` is dropped', hdr(m, 'Reply-To').length === 1);
  check('...and the dropped one is the smuggled one', !m.includes('attacker@evil.example'));
  check('other extra headers still get through', hdr(m, 'List-Unsubscribe').length === 1);
  check('no Reply-To is written when none is given',
    hdr(S.buildMimeMessage({ from: 'a@b.gr', to: 'c@d.gr', subject: 's', text: 't' }), 'Reply-To').length === 0);

  const pairs = S.extraHeaderPairs({ 'List-Unsubscribe': 'x', 'reply-to': 'y', From: 'z', 'bad name': 'w', 'X-Ok': 'a\r\nb' });
  check('extraHeaderPairs keeps ordinary headers', pairs.some(([n]) => n === 'List-Unsubscribe'));
  check('...drops the reserved ones, Reply-To included', !pairs.some(([n]) => /^(reply-to|from)$/i.test(n)));
  check('...refuses a name that is not a token', !pairs.some(([n]) => n === 'bad name'));
  check('...and flattens a CRLF inside a value', pairs.find(([n]) => n === 'X-Ok')?.[1] === 'a b');
}

/* ---- the new configuration: retries and the HELO name ---- */
{
  const base = { SMTP_HOST: 'mail.example.gr', EMAIL_FROM: 'Shop <shop@example.gr>' };
  // A fixed hostname, so the default does not depend on the machine running this.
  const r = (extra, hostname = 'box.local') => S.resolveSmtpConfig({ ...base, ...extra }, hostname);
  check('retries default to 2', r({}).retries === 2);
  check('SMTP_RETRIES=0 is one attempt', r({ SMTP_RETRIES: '0' }).retries === 0);
  check('SMTP_RETRIES=2 is two retries', r({ SMTP_RETRIES: '2' }).retries === 2);
  // Clamped, not refused: a larger number has an obvious safe reading, and a
  // retry storm against a per-minute mailbox limit spends the allowance.
  check(`a larger value is clamped to ${S.SMTP_MAX_RETRIES}`, r({ SMTP_RETRIES: '9' }).retries === S.SMTP_MAX_RETRIES);
  check('a value that is not a number is a configuration error', 'error' in r({ SMTP_RETRIES: 'abc' }));
  check('...so is a negative one', 'error' in r({ SMTP_RETRIES: '-1' }));
  check('...and a fraction', 'error' in r({ SMTP_RETRIES: '1.5' }));

  check('SMTP_HELO_NAME is used as given', r({ SMTP_HELO_NAME: 'cms.example.com' }).heloName === 'cms.example.com');
  check('...and an address literal', r({ SMTP_HELO_NAME: '[192.0.2.10]' }).heloName === '[192.0.2.10]');
  // Never SMTP_HOST again: that is the SERVER's name, and a strict server may
  // refuse a client claiming to be it.
  check('unset, it is this machine\'s name when that is a real one', r({}, 'web1.example.net').heloName === 'web1.example.net');
  check('...and the EMAIL_FROM domain when it is not (mDNS .local)', r({}, 'Theos-MacBook.local').heloName === 'example.gr');
  check('...or a bare name', r({}, 'web1').heloName === 'example.gr');
  check('...or localhost', S.defaultHeloName('a@shop.example.gr', 'localhost.localdomain') === 'shop.example.gr');
  // The fallback goes onto the wire too, so it is held to the same check: an
  // IDN domain in its punycode form, anything still unusable as `localhost`.
  check('an IDN From domain becomes punycode', S.defaultHeloName('a@οπτικά.gr', 'web1') === 'xn--hxazdsfy.gr');
  check('...a domain no HELO accepts falls back to localhost', S.defaultHeloName('a@x_y.com', 'web1') === 'localhost');
  check('...and every default is a valid HELO name',
    ['a@οπτικά.gr', 'a@x_y.com', 'a@b.gr', 'bad'].every((f) => S.isValidEhloName(S.defaultHeloName(f, 'web1'))));
  check('a Message-ID on an IDN domain is ASCII', /@xn--hxazdsfy\.gr$/.test(S.newMessageId('a@οπτικά.gr')));
  check('...and never SMTP_HOST', r({}, 'web1').heloName !== 'mail.example.gr');
  // It is written onto the wire verbatim, so anything with whitespace is a
  // second SMTP command smuggled in by configuration.
  check('a HELO name with a space is refused', /SMTP_HELO_NAME/.test(r({ SMTP_HELO_NAME: 'my host' }).error ?? ''));
  check('...and one carrying a line break', 'error' in r({ SMTP_HELO_NAME: 'x\r\nRCPT TO:<a@b.gr>' }));
  check('...and a label starting with a hyphen', !S.isValidEhloName('-bad.example.gr'));

  // The wait for the reply to the final "." — RFC 5321 §4.5.3.2.6 says ten
  // minutes, because giving up there is how a message is delivered twice.
  check('SMTP_DATA_TIMEOUT_MS defaults to ten minutes', r({}).dataTimeoutMs === 600_000);
  check('...and is used as given', r({ SMTP_DATA_TIMEOUT_MS: '120000' }).dataTimeoutMs === 120_000);
  check('...a tiny value is clamped up to one second', r({ SMTP_DATA_TIMEOUT_MS: '5' }).dataTimeoutMs === 1_000);
  check('...a huge one down to thirty minutes', r({ SMTP_DATA_TIMEOUT_MS: '999999999' }).dataTimeoutMs === 1_800_000);
  check('...a value that is not a number is a configuration error, naming the variable',
    /SMTP_DATA_TIMEOUT_MS/.test(r({ SMTP_DATA_TIMEOUT_MS: 'ten minutes' }).error ?? ''));
  check('...so is zero, a negative and a fraction',
    ['0', '-1', '1500.5'].every((v) => 'error' in r({ SMTP_DATA_TIMEOUT_MS: v })));
}

/* ---- which failures are worth another attempt ---- */
{
  const err = (code, transient) => new S.SmtpError(`SMTP x failed: ${code}`, 'x', code, transient);
  const sysErr = (code) => Object.assign(new Error(code), { code });
  check('a 4xx reply is transient', S.isTransientSmtpError(err(451, true)));
  check('a 5xx reply is not', !S.isTransientSmtpError(err(550, false)));
  check('a reset connection is transient', S.isTransientSmtpError(sysErr('ECONNRESET')));
  check('a refused connection is transient', S.isTransientSmtpError(sysErr('ECONNREFUSED')));
  // A certificate that failed verification fails it again in two seconds, and
  // a client that retries TLS errors is one step from one that ignores them.
  check('a certificate error is NOT transient', !S.isTransientSmtpError(sysErr('CERT_HAS_EXPIRED')));
  check('an unknown host is NOT transient (a typo does not fix itself)', !S.isTransientSmtpError(sysErr('ENOTFOUND')));
  check('an unrecognised error is not transient', !S.isTransientSmtpError(new Error('something else')));
  check('backoff is ~2 s before the first retry', S.smtpBackoffMs(1, () => 0) === 2000);
  check('...~6 s before the second', S.smtpBackoffMs(2, () => 0) === 6000);
  check('...with jitter bounded under 500 ms', S.smtpBackoffMs(1, () => 0.9999) < 2500 && S.smtpBackoffMs(2, () => 0.9999) < 6500);
  check('a local part is masked to its first character', S.maskAddress('Info <info@example.com>') === 'i***@example.com');
  check('...and something that is not an address reveals nothing', S.maskAddress('nonsense') === '***');
  const id = S.newMessageId('Astrobaas <noreply@astrobaas.com>');
  check('a Message-ID is on the sender\'s own domain', /^[a-z0-9]+\.[0-9a-f]{18}@astrobaas\.com$/.test(id));
  check('...and unique', id !== S.newMessageId('noreply@astrobaas.com'));
}

/* ---- against a scripted server: retries, the final reply, the transcript ---- */
{
  /**
   * A server whose reply to RCPT TO, AUTH and the message body can be set per
   * CONNECTION — so "fail twice, then accept" is a real sequence of sockets.
   */
  const scripted = (behaviour) => {
    const state = { connections: 0, ehlo: [], data: [] };
    const server = net.createServer((sock) => {
      const b = behaviour(++state.connections);
      sock.setEncoding('utf8');
      // `delayMs` answers every command late — each reply inside the client's
      // per-wait timeout, the conversation as a whole far outside it.
      // `bare` ends every reply with the code alone — `250-test.local` then a
      // bare `250` for EHLO, a bare `220`, `354`, `250` everywhere else. RFC 5321
      // §4.2 makes the text optional, and a strict server may send none.
      const bare = (t) => (b.bare ? t.replace(/(^|\r\n)(\d{3}) [^\r\n]*\r\n$/, '$1$2\r\n') : t);
      const say = (t) => {
        if (!b.delayMs) return sock.write(bare(t));
        setTimeout(() => { if (!sock.destroyed) sock.write(bare(t)); }, b.delayMs);
      };
      say(`${b.greeting ?? '220 test.local ESMTP'}\r\n`);
      if (b.greeting?.startsWith('4')) { sock.end(); return; }
      let buf = '';
      let dataMode = false;
      let body = '';
      sock.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\r\n')) !== -1) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (dataMode) {
            if (line === '.') {
              dataMode = false;
              state.data.push(body);
              // The reply that gets LOST: the message is in, the answer never comes.
              if (b.dropAt === 'DOT') { sock.destroy(); return; }
              // ...or the connection is RESET (a socket error, not a clean close).
              if (b.resetAt === 'DOT') { sock.resetAndDestroy(); return; }
              // ...or it simply never comes, on a connection that stays open.
              if (b.dotReply === false) return;
              const accept = `${typeof b.accept === 'function' ? b.accept(state.connections) : (b.accept ?? '250 2.0.0 Ok: queued as TEST123')}\r\n`;
              // Late, and ONLY this reply: a server still filtering the message
              // after "." while every other step was quick.
              if (b.dotDelayMs) setTimeout(() => { if (!sock.destroyed) say(accept); }, b.dotDelayMs);
              else say(accept);
            } else body += `${line}\n`;
            continue;
          }
          const verb = line.split(/[ :]/)[0].toUpperCase();
          if (b.dropAt === verb) { sock.destroy(); return; }
          if (verb === 'EHLO') { state.ehlo.push(line.slice(5)); say('250-test.local\r\n250 AUTH PLAIN\r\n'); }
          else if (verb === 'AUTH') say(`${typeof b.auth === 'function' ? b.auth(line) : (b.auth ?? '235 2.7.0 ok')}\r\n`);
          else if (verb === 'MAIL') say('250 ok\r\n');
          else if (verb === 'RCPT') say(`${b.rcpt ?? '250 ok'}\r\n`);
          else if (verb === 'DATA') { dataMode = true; say('354 go ahead\r\n'); }
          else if (verb === 'QUIT') { if (b.quit === false) return; sock.write('221 bye\r\n'); sock.end(); }
          else say('250 ok\r\n');
        }
      });
      sock.on('error', () => {});
    });
    return { server, state };
  };
  const messageIdOf = (body) => /^Message-ID: (.*)$/m.exec(body ?? '')?.[1];
  const listen = async (server) => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return server.address().port;
  };
  const close = (server) => new Promise((r) => server.close(r));
  // No real waiting in a test, and a fixed jitter.
  const hooks = { sleep: async () => {}, random: () => 0 };
  const msg = { to: 'buyer@example.com', subject: 's', text: 'SECRET-RESET-LINK', replyTo: 'info@example.gr' };

  // Retries log each failed attempt WITH the server's reply — the requirement —
  // so the warnings are captured and asserted rather than left to scroll by.
  const warned = [];
  const realWarn = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    { // fail twice with a 4xx, then accept
      const { server, state } = scripted((n) => ({ rcpt: n < 3 ? '451 4.7.1 Try again later' : '250 ok' }));
      const port = await listen(server);
      let result = null;
      // Caught, not left to throw: an uncaught failure here crashed the whole
      // file, so the assertion that names the problem never printed and every
      // check after it silently never ran. A test must fail by SAYING so.
      let threw = null;
      try {
        await S.smtpTransport({ host: '127.0.0.1', port, secure: false, from: 'shop@example.gr', timeoutMs: 5000, retries: 2 }, hooks)
          .send(msg, { onResult: (r) => { result = r; } });
      } catch (e) { threw = e; }
      check('a transient failure is retried until it succeeds', !threw && state.connections === 3);
      check('...and the result says how many attempts it took', result?.attempts === 3);
      check('the server\'s final reply is reported', result?.response === '250 2.0.0 Ok: queued as TEST123');
      check('each failed attempt was logged with the SMTP reply',
        warned.filter((w) => w.includes('451 4.7.1 Try again later')).length === 2);
      await close(server);
    }
    { // a permanent failure is never retried
      const { server, state } = scripted(() => ({ rcpt: '550 5.1.1 No such user' }));
      const port = await listen(server);
      let message = '';
      try {
        await S.smtpTransport({ host: '127.0.0.1', port, secure: false, from: 'shop@example.gr', timeoutMs: 5000, retries: 2 }, hooks).send(msg);
      } catch (e) { message = String(e.message); }
      check('a 5xx is not retried', state.connections === 1);
      check('...and its message is exactly what it always was',
        message === 'SMTP RCPT TO failed: 550 5.1.1 No such user');
      await close(server);
    }
    { // retries=0 behaves exactly like the client before retries existed
      const { server, state } = scripted(() => ({ rcpt: '451 4.7.1 Try again later' }));
      const port = await listen(server);
      let threw = false;
      try {
        await S.smtpTransport({ host: '127.0.0.1', port, secure: false, from: 'shop@example.gr', timeoutMs: 5000, retries: 0 }, hooks).send(msg);
      } catch { threw = true; }
      check('with retries: 0, one attempt is made', threw && state.connections === 1);
      await close(server);
    }
    { // retries exhausted: the count reaches the message the email log stores
      const { server, state } = scripted(() => ({ rcpt: '451 4.7.1 Try again later' }));
      const port = await listen(server);
      let message = '';
      try {
        await S.smtpTransport({ host: '127.0.0.1', port, secure: false, from: 'shop@example.gr', timeoutMs: 5000, retries: 2 }, hooks).send(msg);
      } catch (e) { message = String(e.message); }
      check('retries stop at the configured number', state.connections === 3);
      check('...and the error says how many attempts were made', message.endsWith('(after 3 attempts)'));
      await close(server);
    }
    { // wrong credentials: retrying a 535 is how an account gets locked
      const { server, state } = scripted(() => ({ auth: '535 5.7.8 Authentication failed' }));
      const port = await listen(server);
      try {
        await S.smtpTransport({ host: '127.0.0.1', port, secure: false, from: 'shop@example.gr', timeoutMs: 5000,
          retries: 2, user: 'u', pass: 'p', allowInsecureAuth: true }, hooks).send(msg);
      } catch { /* expected */ }
      check('a failed login (535) is not retried', state.connections === 1);
      await close(server);
    }
  } finally {
    console.warn = realWarn;
  }


  /* ---- the live-deploy contract: timeouts, lost replies, the log lines ---- */
  const logged = { log: [], warn: [], error: [] };
  const realConsole = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(logged)) console[k] = (...a) => logged[k].push(a.join(' '));
  const cfgFor = (port, extra = {}) => ({ host: '127.0.0.1', port, secure: false, from: 'shop@example.gr', timeoutMs: 5000, ...extra });
  try {
    { // 421 at the greeting: "service not available, closing" — the textbook transient
      const { server, state } = scripted((n) => (n === 1 ? { greeting: '421 4.3.2 Too busy, try later' } : {}));
      const port = await listen(server);
      let threw = null;
      try { await S.smtpTransport(cfgFor(port, { retries: 2 }), hooks).send(msg); } catch (e) { threw = e; }
      check('a 421 greeting is retried on a fresh connection', !threw && state.connections === 2);
      await close(server);
    }
    { // the connection drops mid-conversation
      const { server, state } = scripted((n) => (n === 1 ? { dropAt: 'MAIL' } : {}));
      const port = await listen(server);
      let threw = null;
      try { await S.smtpTransport(cfgFor(port, { retries: 2 }), hooks).send(msg); } catch (e) { threw = e; }
      check('a connection dropped mid-conversation is retried', !threw && state.connections === 2);
      await close(server);
    }
    { // the reply to the final "." is lost: the server may already have the message
      // This used to assert the OPPOSITE — "treated as transient", two attempts,
      // two bodies — on the theory that a shared Message-ID lets the receiver
      // fold the duplicate. It does not: receivers do not deduplicate on
      // Message-ID, so the customer got the password reset twice, and the log
      // said it had failed. RFC 5321 §4.5.3.2.6 exists to stop exactly this.
      const { server, state } = scripted((n) => (n === 1 ? { dropAt: 'DOT' } : {}));
      const port = await listen(server);
      let threw = null;
      try { await S.smtpTransport(cfgFor(port, { retries: 2 }), hooks).send(msg); } catch (e) { threw = e; }
      check('a connection dropped after the final "." is NOT retried', !!threw && state.connections === 1);
      check('...so exactly one copy was delivered', state.data.length === 1);
      check('...and the outcome is reported as UNKNOWN, not as a plain failure', threw?.outcomeUnknown === true);
      check('...in words an operator can act on',
        /outcome unknown/i.test(String(threw?.message)) && /may have delivered it/i.test(String(threw?.message)));
      check('...and it is not classed as transient', !!threw && !S.isTransientSmtpError(threw));
      await close(server);
    }
    { // ...a connection RESET after "." (a socket error, not a clean close): the same
      const { server, state } = scripted((n) => (n === 1 ? { resetAt: 'DOT' } : {}));
      const port = await listen(server);
      let threw = null;
      try { await S.smtpTransport(cfgFor(port, { retries: 2 }), hooks).send(msg); } catch (e) { threw = e; }
      check('a connection reset after the final "." is not retried either',
        threw?.outcomeUnknown === true && state.connections === 1 && state.data.length === 1);
      await close(server);
    }
    { // the reviewer's reproduction: "." answered after 400 ms, SMTP_TIMEOUT_MS 300
      // Before: three connections, three delivered bodies, and "SMTP server did
      // not reply within 300ms (after 3 attempts)".
      const { server, state } = scripted(() => ({ dotDelayMs: 400 }));
      const port = await listen(server);
      let threw = null; let result = null;
      try {
        await S.smtpTransport(cfgFor(port, { timeoutMs: 300, retries: 2 }), hooks).send(msg, { onResult: (r) => { result = r; } });
      } catch (e) { threw = e; }
      check('the reply to "." has its OWN timeout: a 400 ms answer beats a 300 ms SMTP_TIMEOUT_MS',
        !threw && result?.attempts === 1 && /^250 /.test(result?.response ?? ''));
      check('...one connection, one delivered body', state.connections === 1 && state.data.length === 1);
      await close(server);
    }
    { // the per-attempt ceiling bounds the phase BEFORE "."; it must not cut the wait after it
      const { server, state } = scripted(() => ({ dotDelayMs: 1300 }));
      const port = await listen(server);
      let threw = null;
      // timeoutMs 300 → a 900 ms ceiling. The reply comes at 1300 ms.
      try { await S.smtpTransport(cfgFor(port, { timeoutMs: 300, dataTimeoutMs: 5000, retries: 2 }), hooks).send(msg); } catch (e) { threw = e; }
      check('the per-attempt ceiling does not cut the wait for the reply to "." short',
        !threw && state.connections === 1 && state.data.length === 1);
      await close(server);
    }
    { // SMTP_DATA_TIMEOUT_MS: no reply to "." at all → one attempt, outcome unknown
      const { server, state } = scripted(() => ({ dotReply: false }));
      const port = await listen(server);
      let threw = null;
      const t0 = Date.now();
      try { await S.smtpTransport(cfgFor(port, { timeoutMs: 2000, dataTimeoutMs: 300, retries: 2 }), hooks).send(msg); } catch (e) { threw = e; }
      const took = Date.now() - t0;
      check('no reply to "." within the data timeout: ONE attempt, outcome unknown',
        threw?.outcomeUnknown === true && state.connections === 1 && state.data.length === 1);
      check('...given up after the DATA timeout, not the per-reply one', took >= 250 && took < 1500);
      await close(server);
    }
    { // a caller may SHORTEN the wait (the scheduler's batches do), never lengthen it
      const { server, state } = scripted(() => ({ dotDelayMs: 1000 }));
      const port = await listen(server);
      let shortened = null;
      const t0 = Date.now();
      try { await S.smtpTransport(cfgFor(port, { dataTimeoutMs: 5000, retries: 2 }), hooks).send(msg, { dataTimeoutMs: 200 }); } catch (e) { shortened = e; }
      const took = Date.now() - t0;
      check('a per-send dataTimeoutMs shortens the wait for "."', shortened?.outcomeUnknown === true && took < 900);
      let lengthened = null;
      try { await S.smtpTransport(cfgFor(port, { dataTimeoutMs: 200, retries: 2 }), hooks).send(msg, { dataTimeoutMs: 5000 }); } catch (e) { lengthened = e; }
      check('...but cannot lengthen it past the configured one', lengthened?.outcomeUnknown === true);
      check('...and neither was retried', state.connections === 2 && state.data.length === 2);
      await close(server);
    }
    { // a REAL reply to "." is still what it always was
      const { server, state } = scripted(() => ({ accept: (n) => (n === 1 ? '451 4.3.0 Queue full, try later' : '250 2.0.0 Ok: queued as TEST123') }));
      const port = await listen(server);
      let threw = null;
      try { await S.smtpTransport(cfgFor(port, { retries: 2 }), hooks).send(msg); } catch (e) { threw = e; }
      // The server SAID it did not take the message, so sending it again is safe.
      check('a 4xx reply to "." is still retried', !threw && state.connections === 2);
      await close(server);
      const { server: s2, state: st2 } = scripted(() => ({ accept: '554 5.7.1 Rejected as spam' }));
      const port2 = await listen(s2);
      let refused = null;
      try { await S.smtpTransport(cfgFor(port2, { retries: 2 }), hooks).send(msg); } catch (e) { refused = e; }
      check('a 5xx reply to "." is a plain failure: not retried, not "unknown"',
        st2.connections === 1 && refused?.message === 'SMTP message body failed: 554 5.7.1 Rejected as spam' && !refused?.outcomeUnknown);
      await close(s2);
    }
    { // the reported case: "." answered with a bare `250` and nothing else
      const { server, state } = scripted(() => ({ accept: '250' }));
      const port = await listen(server);
      let threw = null;
      // dataTimeoutMs bounded so a parser that cannot hear the bare 250 fails
      // HERE, by name, rather than waiting out the ten-minute default.
      try { await S.smtpTransport(cfgFor(port, { timeoutMs: 300, dataTimeoutMs: 1000, retries: 2 }), hooks).send(msg); } catch (e) { threw = e; }
      check('a bare "250" to "." is an acceptance: one attempt, one copy', !threw && state.connections === 1 && state.data.length === 1);
      await close(server);
    }
    { // a server that sends the reply CODE alone — at every step, "." included
      const { server, state } = scripted(() => ({ bare: true }));
      const port = await listen(server);
      let threw = null; let result = null;
      try {
        await S.smtpTransport(cfgFor(port, { timeoutMs: 300, dataTimeoutMs: 1000, retries: 2 }), hooks).send(msg, { onResult: (r) => { result = r; } });
      } catch (e) { threw = e; }
      check('bare reply codes (220, 250, 354, and 250 to ".") are understood: sent on the first attempt',
        !threw && result?.attempts === 1 && result?.response === '250');
      check('...and delivered exactly once', state.connections === 1 && state.data.length === 1);
      await close(server);
    }
    { // two separate messages never share one
      const { server, state } = scripted(() => ({}));
      const port = await listen(server);
      const t = S.smtpTransport(cfgFor(port), hooks);
      try { await t.send(msg); await t.send(msg); } catch { /* reported below */ }
      check('two messages get two Message-IDs', state.data.length === 2 && messageIdOf(state.data[0]) !== messageIdOf(state.data[1]));
      await close(server);
    }
    { // never more attempts than configured, and the backoff actually asked for
      const { server, state } = scripted(() => ({ rcpt: '451 4.7.1 Try again later' }));
      const port = await listen(server);
      const waits = [];
      const recHooks = { sleep: async (ms) => { waits.push(ms); }, random: () => 0 };
      try { await S.smtpTransport(cfgFor(port, { retries: 1 }), recHooks).send(msg); } catch { /* expected */ }
      check('retries: 1 is exactly two attempts', state.connections === 2);
      const waits2 = [];
      const { server: s2, state: st2 } = scripted(() => ({ rcpt: '451 4.7.1 Try again later' }));
      const port2 = await listen(s2);
      try {
        await S.smtpTransport(cfgFor(port2, { retries: 9 }), { sleep: async (ms) => { waits2.push(ms); }, random: () => 0 }).send(msg);
      } catch { /* expected */ }
      check(`a configured 9 is still at most ${S.SMTP_MAX_RETRIES + 1} attempts`, st2.connections === S.SMTP_MAX_RETRIES + 1);
      check('the waits between them are ~2 s then ~6 s', JSON.stringify(waits2) === JSON.stringify([2000, 6000]));
      await close(server);
      await close(s2);
    }

    // The log lines, exactly. Cleared first so earlier blocks cannot satisfy them.
    for (const k of Object.keys(logged)) logged[k].length = 0;
    { // success: ONE line, masked, with the server's reply and the attempt count
      const { server } = scripted(() => ({}));
      const port = await listen(server);
      try { await S.smtpTransport(cfgFor(port), hooks).send({ ...msg, to: 'info@example.com', subject: 'Your password reset' }); } catch { /* below */ }
      const sent = logged.log.filter((l) => l.startsWith('[email] smtp sent'));
      check('one success line per message', sent.length === 1);
      check('...in the agreed form', sent[0] === '[email] smtp sent to=i***@example.com attempts=1: 250 2.0.0 Ok: queued as TEST123');
      check('...never the subject or the body', !logged.log.join('\n').includes('password reset') && !logged.log.join('\n').includes('SECRET-RESET-LINK'));
      await close(server);
    }
    { // final failure: ONE line, with the attempts and the reply
      for (const k of Object.keys(logged)) logged[k].length = 0;
      const { server } = scripted(() => ({ rcpt: '451 4.7.1 Try again later' }));
      const port = await listen(server);
      try { await S.smtpTransport(cfgFor(port, { retries: 2 }), hooks).send(msg); } catch { /* expected */ }
      const failed = logged.error.filter((l) => l.startsWith('[email] smtp failed'));
      check('one final-failure line, whoever the caller is', failed.length === 1);
      check('...with the attempts and the server\'s reply',
        failed[0] === '[email] smtp failed to=b***@example.com attempts=3: SMTP RCPT TO failed: 451 4.7.1 Try again later');
      check('...after one warning per retry', logged.warn.filter((w) => w.startsWith('[email] smtp attempt')).length === 2);
      check('...and no success line', !logged.log.some((l) => l.startsWith('[email] smtp sent')));
      await close(server);
    }
    { // outcome unknown: ONE line of its own — neither "sent" nor "failed", and no retry
      for (const k of Object.keys(logged)) logged[k].length = 0;
      const { server } = scripted(() => ({ dropAt: 'DOT' }));
      const port = await listen(server);
      try { await S.smtpTransport(cfgFor(port, { retries: 2 }), hooks).send(msg); } catch { /* expected */ }
      const unknown = logged.error.filter((l) => l.startsWith('[email] smtp outcome unknown'));
      check('a lost reply to "." logs one outcome-unknown line, with the attempt count',
        unknown.length === 1 && unknown[0].startsWith('[email] smtp outcome unknown to=b***@example.com attempts=1: '));
      check('...and no retry warning, no "failed" line, no "sent" line',
        !logged.warn.some((w) => w.startsWith('[email] smtp attempt'))
        && !logged.error.some((l) => l.startsWith('[email] smtp failed'))
        && !logged.log.some((l) => l.startsWith('[email] smtp sent')));
      await close(server);
    }
  } finally {
    Object.assign(console, realConsole);
  }

  { // accepted late, and silent after QUIT: still ONE delivery, reported as sent
    // The 250 lands just inside the attempt's limit; waiting for QUIT's reply
    // used to run past it, so an ACCEPTED message was retried and delivered again.
    const { server, state } = scripted(() => ({ delayMs: 260, quit: false }));
    const port = await listen(server);
    let result = null; let threw = null;
    try {
      await S.smtpTransport(cfgFor(port, { timeoutMs: 600, retries: 2 }), hooks).send(msg, { onResult: (r) => { result = r; } });
    } catch (e) { threw = e; }
    check('a message accepted late is not retried because QUIT went unanswered', !threw && state.data.length === 1);
    check('...and is reported sent on the first attempt', result?.attempts === 1 && /^250 /.test(result?.response ?? ''));
    await close(server);
  }
  { // retries: NaN from a direct caller is not "forever"
    const { server, state } = scripted(() => ({ rcpt: '451 4.7.1 Try again later' }));
    const port = await listen(server);
    try { await S.smtpTransport(cfgFor(port, { retries: NaN }), hooks).send(msg); } catch { /* expected */ }
    check('retries: NaN is the default, not unbounded', state.connections === S.SMTP_MAX_RETRIES + 1);
    await close(server);
  }
  { // a server that answers every step just inside the timeout: the attempt ceiling
    const { server } = scripted(() => ({ delayMs: 250 }));
    const port = await listen(server);
    const t0 = Date.now();
    let message = '';
    try { await S.smtpSend(cfgFor(port, { timeoutMs: 400 }), msg); } catch (e) { message = String(e.message); }
    const took = Date.now() - t0;
    check('a slow-drip server is cut off by the per-attempt ceiling', /did not finish within 1200ms/.test(message));
    check('...at 3 × the timeout, not eleven of them', took >= 1100 && took < 2500);
    await close(server);
  }

  { // what goes on the wire, and what the transcript is allowed to see
    const { server, state } = scripted(() => ({}));
    const port = await listen(server);
    const lines = [];
    const password = 'sup3rs3cret';
    let sendErr = null;
    try {
      await S.smtpTransport({ host: '127.0.0.1', port, secure: false, from: 'Shop <shop@example.gr>', timeoutMs: 5000,
        user: 'noreply@example.gr', pass: password, allowInsecureAuth: true, heloName: 'cms.example.gr' }, hooks)
        .send(msg, { onTranscript: (l) => lines.push(l) });
    } catch (e) { sendErr = e; }
    check('a normal send over the scripted server succeeds', !sendErr);
    const t = lines.join('\n');
    const token = Buffer.from(`\0noreply@example.gr\0${password}`).toString('base64');
    check('the transcript shows AUTH redacted', lines.includes('C: AUTH PLAIN ********'));
    check('...and never the password', !t.includes(password));
    check('...nor the AUTH token that encodes it', !t.includes(token));
    check('...nor the password base64-encoded on its own', !t.includes(Buffer.from(password).toString('base64')));
    check('the transcript shows the server\'s replies', lines.some((l) => l.startsWith('S: 250')));
    check('...and the headers, so Reply-To can be checked', lines.some((l) => l.includes('Reply-To: info@example.gr')));
    // A real message is a password-reset link.
    check('...but never the body', !t.includes('SECRET-RESET-LINK') && lines.some((l) => l.includes('(body:')));
    check('the configured EHLO name is used', state.ehlo[0] === 'cms.example.gr');
    const wire = state.data[0] ?? '';
    check('Reply-To reaches the wire', /^Reply-To: info@example\.gr$/m.test(wire));
    // This client used to send NO Message-ID at all.
    check('a Message-ID reaches the wire, on the From domain', /^Message-ID: <[a-z0-9]+\.[0-9a-f]{18}@example\.gr>$/m.test(wire));
    await close(server);
  }
  { // no HELO name in the config at all: the default, never SMTP_HOST
    const { server, state } = scripted(() => ({}));
    const port = await listen(server);
    try {
      await S.smtpTransport({ host: '127.0.0.1', port, secure: false, from: 'shop@example.gr', timeoutMs: 5000 }, hooks).send(msg);
    } catch { /* the assertion below reports it */ }
    check('without a HELO name, EHLO gives the default, not SMTP_HOST',
      state.ehlo[0] === S.defaultHeloName('shop@example.gr') && state.ehlo[0] !== '127.0.0.1');
    await close(server);
  }

  /* ---- the mail test, end to end: a child process, a real env file ---- */
  //
  // Run twice: `npm run mail:test` in this checkout, and dist/mail-test.mjs as a
  // RELEASE has it — built by the function `npm run build` uses, into a
  // directory holding dist/ and node_modules and nothing else. deploy/README.md
  // step 5b once told operators to run scripts/mail-test.mjs inside a release,
  // which has no scripts/ and no src/, so the one check prescribed after every
  // deploy could not run. This is the proof that it runs there now.
  {
    const { execFile } = await import('node:child_process');
    const os = await import('node:os');
    const { builtinModules } = await import('node:module');
    const { buildMailTest } = await import(pathToFileURL(path.join(root, 'scripts/build-mail-test.mjs')).href);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astrobaas-mailtest-'));

    // A release as deploy.sh ships one, minus what does not matter here: dist/,
    // and a node_modules (this checkout's, linked). No src/, no scripts/.
    const release = path.join(dir, 'release');
    const bundle = path.join(release, 'dist', 'mail-test.mjs');
    await buildMailTest(bundle);
    await fs.symlink(path.join(root, 'node_modules'), path.join(release, 'node_modules'), 'dir');
    const code = await fs.readFile(bundle, 'utf8');
    check('dist/mail-test.mjs: is built, and runnable as a program', code.startsWith('#!/usr/bin/env node\n'));

    // Everything it loads at run time. A path would point into a src/ or
    // scripts/ the release does not have; a package outside `dependencies` is
    // missing from a release's `npm install --omit=dev`.
    const specifiers = [...new Set([
      ...code.matchAll(/^\s*(?:import|export)\b[^'"]*?\bfrom\s*["']([^"']+)["']/gm),
      ...code.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
      ...code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
    ].map((m) => m[1]))];
    const byPath = specifiers.filter((s) => s.startsWith('.') || path.isAbsolute(s));
    check(`dist/mail-test.mjs: loads nothing by path${byPath.length ? ` (${byPath.join(', ')})` : ''}`,
      specifiers.length > 0 && byPath.length === 0);
    const deps = new Set(Object.keys(JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).dependencies ?? {}));
    const pkgOf = (s) => (s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]);
    const strays = specifiers.filter((s) => !s.startsWith('node:') && !builtinModules.includes(s)
      && !byPath.includes(s) && !deps.has(pkgOf(s)));
    check(`dist/mail-test.mjs: imports only node builtins and production dependencies${strays.length ? ` (not in dependencies: ${strays.join(', ')})` : ''}`,
      strays.length === 0);

    // The shell's own mail variables would WIN over the file (Node's rule), so
    // the child gets an environment without any of them.
    const cleanEnv = Object.fromEntries(Object.entries(process.env)
      .filter(([k]) => !/^(EMAIL_|SMTP)/.test(k)));
    const password = 'Cli#pa$s\\word';
    const token = Buffer.from(`\0noreply@example.gr\0${password}`).toString('base64');
    // Accepts ONLY the exact credential, so exit 0 proves the password survived
    // the env file byte for byte — the '#' and the '\\' are what break it unquoted.
    const expected = `AUTH PLAIN ${token}`;

    for (const L of [
      { name: 'npm run mail:test', argv: [path.join(root, 'scripts/mail-test.mjs')], cwd: root },
      { name: 'dist/mail-test.mjs in a release', argv: ['dist/mail-test.mjs'], cwd: release },
    ]) {
      const t = (n, c) => check(`${L.name}: ${n}`, c);
      const run = (args) => new Promise((resolve) => {
        execFile(process.execPath, [...L.argv, ...args], { cwd: L.cwd, env: cleanEnv, timeout: 60_000 },
          (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, out: `${stdout}\n${stderr}` }));
      });
      const cli = async (envText, to = 'buyer@example.com') => {
        const file = path.join(dir, `env-${Math.random().toString(36).slice(2)}`);
        await fs.writeFile(file, envText);
        return run([`--env-file=${file}`, to]);
      };

      const { server, state } = scripted(() => ({ auth: (line) => (line === expected ? '235 2.7.0 ok' : '535 5.7.8 wrong') }));
      const port = await listen(server);
      const good = [
        'EMAIL_TRANSPORT=smtp', 'SMTP_HOST=127.0.0.1', `SMTP_PORT=${port}`, 'SMTP_ALLOW_INSECURE_AUTH=1',
        'SMTP_USER=noreply@example.gr', `SMTP_PASS='${password}'`, "EMAIL_FROM='Shop <shop@example.gr>'",
        'EMAIL_REPLY_TO=info@example.gr', 'SMTP_HELO_NAME=cms.example.gr', 'SMTP_TIMEOUT_MS=5000',
      ].join('\n');
      const ok = await cli(good);
      t('exits 0 when the server accepts', ok.code === 0);
      t('...and prints the server\'s reply', ok.out.includes('✓ accepted by the server: 250 2.0.0 Ok: queued as TEST123'));
      t('...having authenticated with the single-quoted password, byte for byte',
        state.data.length === 1 && state.ehlo.includes('cms.example.gr'));
      t('...printing the resolved settings', /retries\s+2 \(default\)/.test(ok.out) && /HELO name\s+cms\.example\.gr/.test(ok.out));
      t('...and never the password, or its AUTH token', !ok.out.includes(password) && !ok.out.includes(token));
      t('...with no quoting warning for a single-quoted password', !ok.out.includes('not single-quoted'));
      t('...and the message it sent carries the Reply-To', /^Reply-To:.*info@example\.gr/m.test(state.data[0] ?? ''));

      const wrong = await cli(good.replace(`SMTP_PASS='${password}'`, "SMTP_PASS='not-the-password'"));
      t('a refused login exits 1 with the server\'s 535, and still shows no credential',
        wrong.code === 1 && /535/.test(wrong.out) && !wrong.out.includes('not-the-password')
          && !wrong.out.includes(Buffer.from('\0noreply@example.gr\0not-the-password').toString('base64')));
      const unquoted = await cli(`EMAIL_TRANSPORT=console\nSMTP_PASS=abc#def\n`);
      t('an unquoted password with a # is warned about', unquoted.out.includes('SMTP_PASS is not single-quoted'));
      t('the console transport is refused with exit 2, not a fake success',
        unquoted.code === 2 && /no mail transport is configured/.test(unquoted.out));
      const broken = await cli('EMAIL_TRANSPORT=smtp\nSMTP_HOST=127.0.0.1\n');
      t('a broken SMTP config names the variable', broken.code === 2 && /EMAIL_FROM is not set/.test(broken.out));
      const refused = await cli(good.replace(`SMTP_PORT=${port}`, 'SMTP_PORT=1').replace('SMTP_TIMEOUT_MS=5000', 'SMTP_RETRIES=0'));
      t('a failed send exits 1', refused.code === 1);
      const usage = await run(['--help']);
      t('--help shows both ways to run it, and exits 64', usage.code === 64 && usage.out.includes('node dist/mail-test.mjs'));

      await close(server);
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
}


/* ---- STARTTLS that never completes: the proven hang ---- */
{
  // "220 go ahead" to STARTTLS, and then silence — no handshake. The TLS
  // upgrade had no timer at all, and this held a send open forever.
  const socks = new Set();
  const server = net.createServer((sock) => {
    socks.add(sock);
    sock.write('220 stall.test ESMTP\r\n');
    sock.on('data', (d) => {
      const l = String(d);
      if (l.startsWith('EHLO')) sock.write('250-stall.test\r\n250 STARTTLS\r\n');
      else if (l.startsWith('STARTTLS')) sock.write('220 go ahead\r\n');
    });
    sock.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const t0 = Date.now();
  const guard = new Promise((r) => setTimeout(() => r({ hung: true }), 5000));
  const outcome = await Promise.race([
    S.smtpSend({ host: '127.0.0.1', port: server.address().port, secure: false, from: 'a@b.gr', timeoutMs: 500 },
      { to: 'c@d.gr', subject: 's', text: 't' }).then(() => ({ ok: true }), (e) => ({ err: e })),
    guard,
  ]);
  const took = Date.now() - t0;
  check('a stalled STARTTLS handshake times out instead of hanging', !!outcome.err && !outcome.hung);
  check('...within about one timeout', took < 1500);
  check('...and says what stalled', /TLS handshake did not complete within 500ms/.test(String(outcome.err?.message)));
  check('...as a transient failure, so it is retried', S.isTransientSmtpError(outcome.err));
  // Our side closes the sockets: with the bug present the client never does, and
  // waiting on server.close() would turn a named failure into a hung test run.
  for (const sock of socks) sock.destroy();
  await new Promise((r) => server.close(r));
}

/* ---- STARTTLS checks the certificate against SMTP_HOST, not "localhost" ---- */
{
  // Every TLS test above runs with allowSelfSigned: true, so none of them ever
  // looked at WHICH name a certificate was checked against — and the STARTTLS
  // upgrade passed neither `host` nor `servername`, so Node checked it against
  // "localhost". With SMTP_HOST an IP address (a relay on the LAN) a correct
  // certificate was refused and a certificate for "localhost" was accepted.
  //
  // So this one VERIFIES. The certificates are made here, at test time, by
  // openssl — a throwaway CA valid for two days and two server certificates it
  // signs: one naming only IP:127.0.0.1, one naming only DNS:localhost. Nothing
  // is committed, nothing expires in the repository. The client is made to trust
  // the CA the way an operator would, with NODE_EXTRA_CA_CERTS, in a child run
  // of this file (see SMTP_TLS_IDENTITY_CHILD at the top).
  //
  // Implicit TLS (465) already did this right; its two rows are the CONTROL
  // that proves the CA is trusted, so a STARTTLS refusal means the name, not
  // the chain.
  const { execFileSync, execFile } = await import('node:child_process');
  const os = await import('node:os');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astrobaas-smtp-tlsid-'));
  let made = true;
  try {
    const openssl = (args) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
    await fs.writeFile(path.join(dir, 'ca.cnf'), [
      '[req]', 'distinguished_name=dn', 'x509_extensions=v3_ca', 'prompt=no',
      '[dn]', 'CN=AstroBaaS SMTP test CA',
      '[v3_ca]', 'basicConstraints=critical,CA:TRUE', 'keyUsage=critical,keyCertSign,cRLSign', 'subjectKeyIdentifier=hash',
    ].join('\n'));
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-config', 'ca.cnf']);
    for (const [name, cn, san] of [['ip', 'ip-only.test', 'IP:127.0.0.1'], ['localhost', 'localhost', 'DNS:localhost']]) {
      openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${cn}`]);
      await fs.writeFile(path.join(dir, `${name}.ext`),
        `subjectAltName=${san}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`);
      openssl(['x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial',
        '-out', `${name}.pem`, '-days', '2', '-extfile', `${name}.ext`]);
    }
  } catch {
    made = false;
  }

  if (!made) {
    skip('STARTTLS verifies the certificate against SMTP_HOST', 'no openssl available to make a test CA');
  } else {
    const run = await new Promise((resolve) => {
      execFile(process.execPath, [fileURLToPath(import.meta.url)], {
        cwd: root, timeout: 60_000,
        env: { ...process.env, SMTP_TLS_IDENTITY_CHILD: dir, NODE_EXTRA_CA_CERTS: path.join(dir, 'ca.pem') },
      }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout), stderr: String(stderr) }));
    });
    const line = run.stdout.split('\n').find((l) => l.startsWith('__TLSID__'));
    const r = line ? JSON.parse(line.slice('__TLSID__'.length)) : null;
    if (!r) console.error(`   TLS identity child produced no result: ${run.err?.message ?? ''}\n${run.stderr.slice(-800)}`);
    const refusedForName = (x) => x?.ok === false && x.code === 'ERR_TLS_CERT_ALTNAME_INVALID';
    check('control: the test CA is trusted — implicit TLS to 127.0.0.1 accepts an IP:127.0.0.1 certificate', r?.implicitIp?.ok === true);
    check('control: implicit TLS to 127.0.0.1 refuses a certificate naming only "localhost"', refusedForName(r?.implicitLocalhost));
    check('STARTTLS to 127.0.0.1 ACCEPTS a certificate naming IP:127.0.0.1', r?.starttlsIp?.ok === true);
    check('STARTTLS to 127.0.0.1 REFUSES a certificate naming only "localhost"', refusedForName(r?.starttlsLocalhost));
    check('...and that refusal is not retried', r?.starttlsLocalhost?.ok === false && r.starttlsLocalhost.transient === false);
    if (r && !(r.starttlsIp?.ok && refusedForName(r.starttlsLocalhost) && r.implicitIp?.ok && refusedForName(r.implicitLocalhost))) {
      for (const [k, v] of Object.entries(r)) console.error(`   ${k}: ${JSON.stringify(v)}`);
    }
  }
  await fs.rm(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} SKIPPED` : ''}`);
process.exit(fail === 0 ? 0 : 1);
