# Worker WebSocket Protocol Specification (WIP)

## Handshake
Client connects to `/ws/worker`
Client sends `hello`:
```json
{ "type": "hello", "workerId": "worker-1", "maxSlots": 4 }
```
Server responds with `welcome` or assigns jobs.
