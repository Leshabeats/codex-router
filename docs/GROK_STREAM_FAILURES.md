# Grok stream failure boundary

The Grok forwarder serves Chat Completions to LiteLLM. Its streamed errors must
use `data: {"error":{"type":"api_error","code":"local_router_stream_failed","message":"..."}}`.
The client-facing Router continues to serve Responses terminal errors. Error
messages are fixed local descriptions, not provider bodies or stack traces.

A top-level Responses `type:error` emitted into the Chat boundary was accepted
by the installed Python client as a chunk without choices. LiteLLM 1.96.0 then
raised `IndexError` in its Responses transformation. The protocol regression
reproduces that exception with the old forwarder and passes with the nested
Chat error. No dependency update or installed Python modification is required.

Run the full offline regression against a lock-installed Python environment:

```sh
node scripts/verify-grok-apply-patch-guidance.mjs "$venv_python" --native-hook --stream-probes
```

It covers failed/incomplete/missing terminals, truncated JSON, disconnection,
explicit errors and exhausted post-tool repair. It checks one terminal error,
no successful completion or executable closed tool after failure, no private
error text, and no LiteLLM IndexError. Cancellation and native hook history are
also covered by the same protocol fixture. Shutdown uses the Chat error writer
only for the Grok forwarder; other services keep the Responses writer.

Repeated lifecycle closes and multiple reasoning items are tested through the
whole gateway with two identical legitimate deltas and successive requests.
Their text is preserved exactly, without multiplying completion snapshots or
dropping intentional repetitions. This fixture does not establish the origin
of repetitions in a historical live rollout. Do not deduplicate prose by value
or label historical repetitions as provider-side without hop-level evidence.
