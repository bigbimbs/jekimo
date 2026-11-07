/**
 * Size and cardinality limits for event envelope v1, part of the public
 * contract (docs/event-format.md). SDKs truncate or drop data to stay within
 * them before sending; the ingestion API rejects events that exceed them.
 */
export const LIMITS = {
  /** Maximum serialized size of one event in bytes (UTF-8 JSON). */
  MAX_EVENT_BYTES: 128 * 1024,
  /** Maximum number of events in one ingestion request. */
  MAX_BATCH_EVENTS: 100,
  /** Maximum serialized size of one ingestion request in bytes. */
  MAX_BATCH_BYTES: 1024 * 1024,

  MAX_MESSAGE_CHARS: 4096,
  MAX_SHORT_STRING_CHARS: 128,
  MAX_FINGERPRINT_CHARS: 256,
  MAX_PROJECT_ID_CHARS: 64,

  MAX_EXCEPTION_TYPE_CHARS: 256,
  MAX_EXCEPTION_VALUE_CHARS: 4096,
  MAX_STACKTRACE_CHARS: 64 * 1024,

  MAX_SDK_NAME_CHARS: 64,
  MAX_SDK_VERSION_CHARS: 32,

  MAX_CONTEXT_KEYS: 32,
  MAX_CONTEXT_KEY_CHARS: 64,
  MAX_CONTEXT_VALUE_CHARS: 1024,

  MAX_ATTRIBUTE_KEYS: 64,
  MAX_ATTRIBUTE_KEY_CHARS: 64,
  MAX_ATTRIBUTE_STRING_CHARS: 1024,
  MAX_ATTRIBUTE_ARRAY_ITEMS: 32,
  /** `attributes` itself is depth 1; values nested inside it may go to this depth. */
  MAX_ATTRIBUTE_DEPTH: 4,

  /** Events with a timestamp further in the future than this are rejected. */
  MAX_FUTURE_SKEW_MS: 5 * 60 * 1000,
} as const;
