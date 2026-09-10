# Native relay authentication recovery

Encrypted Codex collaboration tasks require the signed-in native relay before
they can reach Grok. `ERR_NATIVE_AGENT_RELAY_UNAUTHORIZED` is a native relay
401, distinct from rejection of the Grok CLI OAuth session by xAI and from a
`local_router_stream_failed` transport error.

The caller retains ownership of its native authorization. An expired credential
is forwarded once and the 401 is returned to Codex. A subsequent request with
valid refreshed client authorization can relay the same task successfully.
The Router does not substitute another account's token or refresh a revoked
client refresh token. That condition requires the client's normal sign-in flow.

Payload caches and in-flight coalescing are partitioned by resolved account and
credential. A refreshed credential performs its own relay; invalid credentials
cannot reuse another credential's cached plaintext. 401 is not cached as a 429
rate-limit backoff. Identical valid credentials may reuse their own cache.

The routing and resilience suites cover successful post-401 recovery, concurrent
account/credential separation, same-credential cache reuse, rejected credentials,
429 backoff, and cancellation of one or all coalesced waiters. These tests passed
without an authorization runtime change. They do not establish that an external
identity service will refresh a revoked credential.
