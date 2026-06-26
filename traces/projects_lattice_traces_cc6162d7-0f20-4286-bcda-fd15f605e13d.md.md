# Lattice Trace — cc6162d7-0f20-4286-bcda-fd15f605e13d

**Session:** 0bd9aabc-7c4a-4f42-8d29-0792a5c8b40c  
**Recorded:** 2026-06-26 06:47:31 UTC  
**Duration:** 787ms

## Metrics

```
Trace:    cc6162d7-0f20-4286-bcda-fd15f605e13d
Session:  0bd9aabc-7c4a-4f42-8d29-0792a5c8b40c
Duration: 787ms
Actions:  1 total, 1 succeeded (100.0%)
Network:  0 requests
Grants:   0 allowed, 0 denied
Tiers:    L1×1
Events:   session_start=1, action=1, action_result=1, snapshot=1, metrics=1, session_end=1
```

## Event Summary

| Kind | Count |
|------|-------|
| session_start | 1 |
| action | 1 |
| action_result | 1 |
| snapshot | 1 |
| metrics | 1 |
| session_end | 1 |

## Events

- `06:47:31.616` **session_start** topology=ephemeral
- `06:47:31.618` **action** navigate → data:text/html,<h1>Bank</h1><a href='/x'>Link</a><input id=u>
- `06:47:32.386` **action_result** success=true url=data:text/html,<h1>Bank</h1><a href='/x'>Link</a><input id=u>
- `06:47:32.390` **snapshot** tier=L1 nodes=3 url=data:text/html,<h1>Bank</h1><a href='/x'>Link</a><input id=u>
- `06:47:32.403` **metrics** actions=1 success=100.0%
- `06:47:32.403` **session_end** duration=787ms