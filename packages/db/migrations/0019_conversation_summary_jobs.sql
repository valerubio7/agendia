-- Summary workers append immutable versions; raw history remains authoritative.
GRANT INSERT ON conversation_summaries TO agendia_worker_runtime;
