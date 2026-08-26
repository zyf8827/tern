# Worker WebSocket Protocol Specification (WIP)

## Handshake
Client connects to `/ws/worker`
Client sends `hello`:
```json
{ "type": "hello", "workerId": "worker-1", "maxSlots": 4 }
```
Server responds with `welcome` or assigns jobs.

## Messages
- `hello`: Worker registers capabilities and max slots
- `assign`: Server sends test case bundle and run ID
- `heartbeat`: Ping/pong keepalive
- `finished`: Worker reports status and duration
