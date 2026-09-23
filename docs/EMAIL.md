# Email

Everything AstroBaaS sends — password resets, contact-form notifications, order
confirmations, newsletter batches — goes through one transport, configured
entirely from the environment. Moving to another mail server is an edit to
`.env` and a restart, never a code change.

For the configuration in brief, see [README.md § Email](../README.md#email).
This page is the operator's reference: what is retried, what is deliberately
never retried, what each refusal from a mail server means, and how to prove the
channel works before you need it.

Out of the box nothing is sent: `EMAIL_TRANSPORT` defaults to `console`, which
prints each message to the server log. To send for real, point it at a mail
server you have an account on — your host's, your own, or a provider's SMTP
relay. Everything is environment-driven, so moving to another server is an edit
to `.env` and a restart, never a code change.

```ini
EMAIL_TRANSPORT=smtp
SMTP_HOST=mail.example.com
SMTP_PORT=587                      # 587 = STARTTLS; or 465 with SMTP_SECURE=1
SMTP_USER=noreply@example.com
SMTP_PASS=                         # the secret — set on the server, never committed
EMAIL_FROM="Example <noreply@example.com>"
EMAIL_REPLY_TO=info@example.com    # where replies go, if EMAIL_FROM is unmonitored
SMTP_TIMEOUT_MS=10000              # per network wait; one attempt is capped at 3×
SMTP_DATA_TIMEOUT_MS=600000        # the default (10 min); wait for the reply to the end of the message
SMTP_RETRIES=2                     # the default; 0–2, transient failures only
SMTP_HELO_NAME=cms.example.com     # optional; the name given in EHLO
EMAIL_CAMPAIGNS=0                  # optional; if the mailbox must not carry newsletters
```

Every one of these but `EMAIL_TRANSPORT`, `SMTP_HOST` and `EMAIL_FROM` is
optional. `SMTP_HELO_NAME` defaults to this machine's name when that is a real
one (dotted, not `.local`), and otherwise to `EMAIL_FROM`'s domain (in its
punycode form for a Greek or other IDN domain, `localhost` if even that is not a
valid name) — never to `SMTP_HOST`, which is the *server's* name and which a
strict server refuses.

## The password

It is read from the environment and nothing else: never written to
the database, never logged, never returned by an endpoint, and redacted in the
test transcript. On the reference deployment it lives in `shared/.env`
(`0640 root:www-data`, see [deploy/README.md](../deploy/README.md)). Edit it with
`sudoedit /var/www/<site>/shared/.env` — that keeps the file's owner and mode,
and the password never touches your shell history — and **single-quote it**:

```ini
SMTP_PASS='the-password'
```

Always single quotes, because unquoted the two parsers that read this file
disagree, and both damage some passwords. Measured with `a b#c"d\e$f`:
systemd's `EnvironmentFile` drops the backslash, and Node's env-file loader
(which `npm run mail:test --env-file` uses) stops at the `#` and reads `a b`.
Single-quoted, both read it byte for byte. A generated password is exactly the
kind that contains a `#` or a `\`, and the symptom is a baffling `535`. (A
password containing a single quote cannot be written this way — pick another.)

## Check it — the step never to skip
 In a checkout:

```bash
npm run mail:test -- --env-file=/var/www/<site>/shared/.env you@example.com
```

A built or deployed release has no source to compile, so `npm run build` leaves
the same test precompiled in `dist/`, and that is the one to run on the server
(under systemd, below) or in the container:

```bash
docker compose exec app node dist/mail-test.mjs you@example.com
```

It sends one message through the app's own mail code — the same Reply-To, the
same refusals, the same transport — and prints the configuration (the password
only as *set* or *not set*), the SMTP conversation with the AUTH line masked,
and the server's final reply:

```text
✓ accepted by the server: 250 2.0.0 Ok: queued as 4ZxY1k2Q3Rz
```

It exits 0 on acceptance and non-zero otherwise, so a deploy script can assert
it. Two things to know about `--env-file`: a variable already exported in your
shell wins over the file, and the file is read by Node's parser, not systemd's —
they agree on single-quoted values (above), and the test warns if `SMTP_PASS`
is not quoted and contains a character they read differently. To run with
exactly what the service sees instead — the release's own copy, since a
release has no `scripts/`:

```bash
sudo systemd-run --pipe --wait --quiet --uid=www-data --gid=www-data \
  -p EnvironmentFile=/var/www/<site>/shared/.env \
  -p WorkingDirectory=/var/www/<site>/current \
  /usr/bin/node dist/mail-test.mjs you@example.com
```

A `250` means the server **accepted** the message, not that it arrived — check
the inbox and the spam folder. The deep health check (`/api/health/deep`) then
reports the channel under `email_channel`, including where replies go.

## Reply-To

`EMAIL_REPLY_TO` goes on every message, whatever the transport —
set it whenever `EMAIL_FROM` is a `noreply` box. Form notifications (the contact
form, and any content type with an email field) use the *submitter's* address
instead, so pressing Reply answers the person who wrote; a submitted value that
is not a usable address is dropped for the default and never reaches a header.
If `EMAIL_REPLY_TO` itself is unusable, mail still goes — without a Reply-To —
and the server log (once, at startup) and `/api/health/deep` both say so:
losing a password reset to protect where the answer goes is the worse trade.

## What is retried, and what never is

Retries are **on by default**. A failure
the protocol calls transient — a `4xx` reply, a dropped connection, a timeout —
*before the message has been sent* is tried again on a fresh connection after
~2 s, then ~6 s (`SMTP_RETRIES`, default 2, at most 2; `0` turns them off). A
`5xx`, a failed login (`535`) and a certificate that does not verify are never
retried: the first cannot succeed, the second is how accounts get locked, the
third is a security failure. Retries are not a way past a per-minute sending
limit; a few seconds cannot outlast one.

## Outcome unknown — never sent twice

Once the final `.` that ends the message
has gone, the server usually *has* the message and is filtering and queueing it.
If its reply then never comes — no answer within `SMTP_DATA_TIMEOUT_MS`, or the
connection drops or resets — nobody can know whether it was accepted, so the
message is **not** sent again, whatever `SMTP_RETRIES` says: a retry there is
how a customer gets the same password reset three times. That wait has its own
timeout, ten minutes by default as RFC 5321 §4.5.3.2.6 asks (`SMTP_DATA_TIMEOUT_MS`,
clamped to 1 s – 30 min), and the per-attempt cap does not cut it short. Such a
send is reported as neither sent nor failed but **outcome unknown**: its own log
line, `outcome: "unknown"` (with `ok: false`) in the email log and in
`/api/health/deep`'s `email_channel.data.last_send`, "outcome unknown" on
Admin → Operations, and a campaign counts it as *unconfirmed*. Check the inbox
before resending one. A real `4xx` reply to the `.` is still retried — the
server said it did not take the message — and a `5xx` is a plain failure.

## How long a send can take

`SMTP_TIMEOUT_MS` bounds each single wait before
the message is sent — the connection, the TLS handshake, each reply — and that
part of an attempt is cut off at three times that. After the final `.`, only
`SMTP_DATA_TIMEOUT_MS` applies, and only one attempt ever gets there. The worst
case for one message is therefore three attempts of `3 × SMTP_TIMEOUT_MS`, the
backoff, and one `SMTP_DATA_TIMEOUT_MS`: about 12½ minutes at the defaults,
almost all of it a server that took the message and never said so. Nothing
waits on it: every send from a request (form notifications, order mail,
password resets) is handed off, and the response goes back straight away. The
scheduler's own mail — unpaid-order reminders, back-in-stock notices, newsletter
batches — goes out one message at a time on the same tick as scheduled posts
and order expiry, so it waits at most **one minute** for that reply (or
`SMTP_DATA_TIMEOUT_MS`, if lower), which keeps one silent server from stalling
the sweep for ten minutes a message.

## What gets logged

One line per message, and never the subject, the body or
a credential:

```text
[email] smtp sent to=i***@example.com attempts=1: 250 2.0.0 Ok: queued as 4ZxY1k2Q3Rz
[email] smtp attempt 1 of 3 failed to=i***@example.com: SMTP RCPT TO failed: 451 4.7.1 Try again later — retrying in 2140 ms
[email] smtp failed to=i***@example.com attempts=3: SMTP RCPT TO failed: 451 4.7.1 Try again later
[email] smtp outcome unknown to=i***@example.com attempts=1: SMTP outcome unknown: the whole message was sent, but no reply came within 600000ms. The server may have delivered it, so it was not sent again.
```

The email log (Admin → Operations) keeps the server's reply for every message
that went, so the queue id is there when a customer says one never arrived. If
a server echoes the credential back in a reply — a broken one can — it is
replaced with `********` before it reaches any of these.

## When it does not work

The reason is in the health check and in the server
log, in the server's own words:

| You see | It means |
| --- | --- |
| `mail is not being sent: EMAIL_TRANSPORT=smtp but SMTP_USER is set but SMTP_PASS is not` | The configuration was rejected before any connection — the message names the variable. |
| `SMTP authentication failed: 535 …` | Wrong user or password. Not retried. |
| `SMTP MAIL FROM failed: 553 …` / `… 550 … not owned by user` | `EMAIL_FROM` is not an address this account may send as. Many hosted mailboxes accept only their own. |
| `SMTP RCPT TO failed: 550 …` | The recipient was refused. Permanent. |
| `… 4xx … (after 3 attempts)` | A transient refusal that outlasted the retries — often a rate limit. |
| `self-signed certificate` / `CERT_HAS_EXPIRED` | The server's certificate does not verify. Fix the certificate; `SMTP_ALLOW_SELF_SIGNED=1` exists only for a relay on your own network. |
| `Refusing to send credentials over an unencrypted connection` | The server offered no STARTTLS on this port. Use 465 with `SMTP_SECURE=1`. |
| `SMTP EHLO failed: 5xx …` | The server does not accept the name this client gives. Set `SMTP_HELO_NAME` to this machine's public host name. |
| `SMTP TLS handshake did not complete within …` / `SMTP attempt did not finish within …` | The server stopped answering mid-conversation, before the message was sent. Transient, so it was retried. |
| `SMTP outcome unknown: the whole message was sent, but …` | The server never answered the end of the message. It may well have been delivered, and it was **not** resent. Check the inbox; if these are frequent, the server is slow to answer — raise `SMTP_DATA_TIMEOUT_MS` or ask the host. |
| `Hostname/IP does not match certificate's altnames` | The certificate does not name `SMTP_HOST`. With an IP address there, the certificate must list that address (`IP:…`), not a host name. An internal CA can be trusted with `NODE_EXTRA_CA_CERTS=/path/ca.pem` in the service's environment rather than `SMTP_ALLOW_SELF_SIGNED=1`. |

## Transactional-only mailboxes

A hosted `noreply` address is typically capped
per minute and licensed for one-to-one mail. With `EMAIL_CAMPAIGNS=0` (or
`false`, `no`, `off`), newsletter campaigns are refused at the moment you press
Send — with the reason — and one that was already queued waits, with nobody
marked as failed, instead of going out. Password resets, order confirmations and
form notifications are unaffected.
