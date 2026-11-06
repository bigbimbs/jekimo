# @jekimo/sdk-node

Node.js SDK for [Jekimo](https://github.com/bigbimbs/jekimo), the open-source, self-hosted error, crash, and log observability platform. It reports exceptions, structured logs, and custom events to your own Jekimo instance.

> **Alpha.** The API may change before 1.0, and so may the [event format](https://github.com/bigbimbs/jekimo/blob/main/docs/event-format.md) and [ingestion protocol](https://github.com/bigbimbs/jekimo/blob/main/docs/ingestion-protocol.md) it implements. The Jekimo server is still being built, so this SDK has only been tested against a mocked transport.

- Zero runtime dependencies. Uses Node's built-in `fetch`, `zlib`, and `crypto`.
- Never blocks your application. Capture calls build the event and return; sending happens in the background, and nothing on your request path waits for the network.
- Bounded memory. At most 1,000 events are queued by default, and the oldest are dropped first.
- Safe by default. No request bodies, headers, cookies, environment variables, or local variables are collected, and sensitive keys are redacted before an event leaves the process.
- ESM and CommonJS, with TypeScript types.

Requires Node.js 22.12 or later.

## Install

```bash
npm install @jekimo/sdk-node
```

## Quick start

Create a project in your Jekimo instance, copy its ingestion key (it is shown once), and keep it in your secret store or environment, not in source control.

```js
import * as jekimo from "@jekimo/sdk-node";

jekimo.init({
  dsn: process.env.JEKIMO_DSN, // https://jk_<key_id>_<secret>@jekimo.example.com
  service: "billing-api",
  environment: "production",
  release: process.env.GIT_SHA,
});

// Report crashes without changing how the process crashes.
jekimo.captureUnhandled();

try {
  await chargeInvoice(invoice);
} catch (error) {
  jekimo.captureException(error, {
    context: { request_id: req.id },
    attributes: { invoice_id: invoice.id, retry_count: 2 },
  });
  throw error;
}

jekimo.log("warning", "Retrying payment provider call after timeout", { provider: "example-pay", attempt: 1 });
jekimo.captureMessage("Nightly reconciliation completed", "info", { attributes: { mismatches: 0 } });

// On shutdown (for example in your SIGTERM handler), send what is queued.
await jekimo.close();
```

CommonJS works the same way:

```js
const jekimo = require("@jekimo/sdk-node");
```

`init` returns a client, and the top-level functions call the client from the most recent `init`. You can use the client directly instead:

```js
const client = jekimo.init({ baseUrl: "https://jekimo.example.com", ingestionKey: process.env.JEKIMO_INGESTION_KEY });
client.captureException(new Error("boom"));
```

### Connecting

Use either form:

- `dsn`: `https://<ingestion key>@<host>[:port][/path]`. The SDK moves the key into the `Authorization: Bearer` header and never puts it in a request URL.
- `baseUrl` and `ingestionKey`: the instance address, for example `https://jekimo.example.com`, plus the key `jk_<key_id>_<secret>`.

Events are posted to `<base>/api/v1/ingest`; a path in the base address is kept, for an instance behind a reverse proxy under a sub-path. Use HTTPS. Plain HTTP is accepted for loopback addresses; for any other host the SDK still sends but reports an `insecure_transport` error, because the key would travel unencrypted.

If the configuration is unusable (no address, a malformed key, a bad URL), `init` does not throw. It reports an `invalid_config` error and returns a disabled client whose methods do nothing, so a missing environment variable cannot crash your service.

## API

| Function | Description |
| --- | --- |
| `init(options)` | Creates a client and makes it the default. Returns the client. |
| `captureException(error, options?)` | Sends a `kind: "exception"` event, severity `error` by default. Accepts any thrown value. Returns the event id. |
| `captureMessage(message, severity?, options?)` | Sends a `kind: "event"` event, severity `info` by default. |
| `log(severity, message, attributes?)` | Sends a `kind: "log"` event. |
| `captureEvent(partialEnvelope)` | Sends a custom envelope. You supply `message` and any other envelope fields; the SDK fills in `event_id`, `timestamp`, `sdk`, and your configured `service`, `environment`, and `release`. Defaults: kind `event`, severity `info`. |
| `flush(timeoutMs?)` | Sends everything queued. Resolves `true` when the queue is drained, `false` if the timeout (default 2,000 ms) passed first. |
| `close(timeoutMs?)` | Flushes within the timeout, then stops the client. Anything still unsent is dropped and reported to `onDrop`. |
| `captureUnhandled(options?)` | Reports `uncaughtException` and `unhandledRejection`. Returns a function that removes the handlers. See below. |
| `client.stats()` | `{ queued, sent, rejected, dropped }` counters. |

The capture functions return the new event's id, or `undefined` when nothing was queued (the client is disabled, the event was sampled out, or it was invalid).

`options` for `captureException` and `captureMessage`: `severity`, `message` (overrides the derived message), `fingerprint`, `context`, and `attributes`.

Severities are `debug`, `info`, `warning`, `error`, and `fatal`.

### Exceptions

The SDK records the error's `name` as `exception.type`, its `message` as `exception.value`, and its `stack` as `exception.stacktrace`. A `cause` chain is appended to the stack text as `Caused by:` sections, up to eight levels deep, and the members of an `AggregateError` are listed. A thrown value that is not an error, such as a string, is recorded with type `NonError`.

### Crashes

```js
jekimo.captureUnhandled({ timeoutMs: 2000 });
```

When no other handler is installed, an uncaught exception or unhandled rejection is reported as a `fatal` exception, the SDK waits up to `timeoutMs` for it to be delivered, and then the process crashes with the original error, exactly as it would without the SDK. If your application installs its own `uncaughtException` or `unhandledRejection` handler, the SDK only reports and leaves the decision to your handler. The `--unhandled-rejections` mode is respected.

### Wrapping request handlers

The SDK ships no framework integrations yet. A few lines cover Express, Fastify, Koa, or plain `http` handlers:

```js
import { captureException } from "@jekimo/sdk-node";

export function wrapHandler(fn) {
  return async function wrapped(req, res, next) {
    try {
      return await fn(req, res, next);
    } catch (error) {
      captureException(error, {
        context: { request_id: String(req.headers["x-request-id"] ?? "") },
        attributes: { route: req.route?.path ?? req.url?.split("?")[0] },
      });
      throw error; // or next(error) in Express
    }
  };
}

app.get("/invoices/:id", wrapHandler(async (req, res) => { /* ... */ }));
```

Record only what you need. Do not attach request bodies, headers, cookies, or user identifiers unless you have decided to collect them.

## Configuration

Every default comes from the [ingestion protocol](https://github.com/bigbimbs/jekimo/blob/main/docs/ingestion-protocol.md#sdk-requirements) and [event format](https://github.com/bigbimbs/jekimo/blob/main/docs/event-format.md).

| Option | Default | Description |
| --- | --- | --- |
| `dsn` | | `https://<ingestion key>@<host>[/path]`. Use this or `baseUrl` with `ingestionKey`. |
| `baseUrl` | | Instance address, for example `https://jekimo.example.com`. |
| `ingestionKey` | | Project ingestion key, `jk_<key_id>_<secret>`. |
| `service` | | Logical service name, sent on every event. |
| `environment` | | For example `production` or `staging`. |
| `release` | | Version, tag, or commit of your application. |
| `context` | `{ runtime: "node/<version>" }` | Context entries added to every event, for example `{ host: "api-1" }`. Merged with the default. |
| `captureContext` | `true` | Set `false` to send no `context` at all. |
| `sampleRate` | `1` | Fraction of `log` and `event` events at `debug`, `info`, and `warning` to send. Exceptions and `error` or `fatal` events are always sent. Uses the same deterministic rule as the server. |
| `redactKeys` | `[]` | Extra keys to redact, in addition to the defaults below. |
| `redactPatterns` | `[]` | Regular expressions; any `context` or `attributes` key that matches is redacted. |
| `maxQueueSize` | `1000` | Events held in memory. When full, the oldest is dropped. |
| `flushIntervalMs` | `2000` | Queued events are sent at least this often. |
| `maxBatchEvents` | `100` | Send as soon as this many events are queued, and send at most this many per request. Capped at 100. |
| `maxBatchBytes` | `524288` (512 KiB) | Send as soon as this many bytes of serialised events are queued, and send at most this many per request. Capped below the 1 MiB request limit. |
| `shutdownTimeoutMs` | `2000` | Longest the exit flush and `close()` wait. |
| `flushOnExit` | `true` | Flush when the process exits naturally (`beforeExit`). |
| `transport` | global `fetch` | A `fetch`-compatible function, for tests or a custom HTTP agent. |
| `onError` | `console.warn` | Receives `{ code, message, status?, serverCode?, eventId?, issues? }`. Codes: `invalid_config`, `insecure_transport`, `invalid_event`, `event_rejected`, `request_failed`, `retries_exhausted`. |
| `onDrop` | | Receives `{ reason, count }` whenever events are dropped. Reasons: `queue_full`, `invalid_event`, `request_failed`, `retries_exhausted`, `shutdown`. |
| `debug` | `false` | `true` logs SDK activity with `console.debug`; a function receives each line instead. |

### Delivery

- Events are sent in batches of up to 100 events or 512 KiB, whichever comes first, and at least every 2 seconds.
- Request bodies larger than 8 KiB are gzip-compressed.
- Each request sends `Authorization`, `Content-Type: application/json`, `Content-Encoding: gzip` when compressed, and `User-Agent: @jekimo/sdk-node/<version>`. A request is abandoned after 10 seconds.
- Network errors, `429`, `503`, and other `5xx` responses are retried with exponential backoff from 1 second, doubling to a 60-second cap, with full jitter. A `Retry-After` header (or `error.retry_after` in the body) is used instead when present. A batch is dropped after 5 attempts.
- Other `4xx` responses are never retried. The batch is dropped and the failure is reported to `onError` once per status and error code.
- A `202` response with rejected events counts as success for the accepted ones. Each rejection is reported to `onError` with its validation issues, and rejected events are never resent.
- On natural process exit the SDK flushes once, for at most `shutdownTimeoutMs`. It never keeps an idle process alive and does not listen for signals: call `close()` in your own shutdown handler.

## Privacy defaults

- The SDK collects nothing you do not pass to it, apart from `context.runtime` (`node/<version>`). It does not read request bodies, response bodies, headers, cookies, environment variables, or local variables.
- The value of any `context` or `attributes` key is replaced with `[REDACTED]` when the key, lower-cased with `-`, `_`, and spaces removed, is one of: `authorization`, `proxyauthorization`, `cookie`, `setcookie`, `password`, `passwd`, `secret`, `token`, `accesstoken`, `refreshtoken`, `idtoken`, `apikey`, `accesskey`, `secretkey`, `privatekey`, `clientsecret`, `sessionid`, `creditcard`, `cardnumber`, `cvv`, `ssn`. Redaction applies at every nesting depth, including objects inside arrays. Add keys with `redactKeys` and expressions with `redactPatterns`.
- Redaction happens in your process, before the event is serialised. Your Jekimo server can apply further redaction rules of its own.
- Do not put user identifiers, email addresses, or IP addresses in `context` unless you have decided to collect them. If you need a user identifier for debugging, hash it first.
- The ingestion key is never logged, including in `debug` output and `onError` messages.

### Limits

The SDK keeps every event within the [event format limits](https://github.com/bigbimbs/jekimo/blob/main/docs/event-format.md#fields) instead of letting the server reject it: messages are cut at 4,096 characters, exception values at 4,096, stack traces at 65,536, and attribute and context strings at 1,024, with `…` marking the cut. Objects keep their first 64 keys, arrays their first 32 items, and context its first 32 entries; anything nested deeper than four levels becomes `"[Truncated]"`, and circular references become `"[Circular]"`. `Date` values become ISO strings, `BigInt` and non-finite numbers become strings, and functions and symbols are left out. If an event is still larger than 128 KiB, the largest attributes are dropped first, then the stack trace is shortened. Every event is validated before it is queued; one that is still invalid is reported to `onError` and dropped.

## Not yet supported

- Framework integrations (Express, Fastify, Koa, Nest) and automatic request context.
- Breadcrumbs, tracing spans, and automatic `trace_id` propagation.
- Structured stack frames and source maps.
- Persisting the queue to disk across restarts.
- Bridges for logging libraries such as pino or winston.
- Browser, edge, and other non-Node runtimes.

## License

[Apache-2.0](LICENSE)
